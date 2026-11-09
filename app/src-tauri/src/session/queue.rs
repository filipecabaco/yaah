//! A chat's message queue: what the user sends while a turn runs waits here and
//! goes together, as one message, when each turn ends. Rust owns it: what is queued,
//! the order, when the next one goes and when the queue pauses. The UI only shows
//! it and asks for changes.
//!
//! - **Queuing.** `send_prompt` queues a message instead of sending it while the chat
//!   is busy: a turn runs, or a queued message is on its way (its references being
//!   read, its turn starting). Otherwise it is sent as before, even when a paused
//!   queue holds messages: an explicit send goes now and the queue stays paused.
//! - **What an item holds** is what a send takes: the text, the `@` mentions, the
//!   attachments (moved out of the composer's staging, so they are the queue's now
//!   and kept with the chat across restarts) and how many `#` references the text
//!   has. The references themselves are read when the item is sent, not when it is
//!   queued. The model and effort the chat had when it was queued are recorded to
//!   show; the chat's picks when it is sent apply (pickers are locked while a turn
//!   runs, so they only differ when the user changed them while the queue waited).
//! - **Dispatch.** When a turn ends normally (stop reason `end_turn`, no error, no
//!   permission request left waiting) the first item goes, with no UI involved.
//! - **Pausing.** Any other end pauses the queue, with why: an error (the agent
//!   failed or exited), a stop by the user (Stop, or stop reason `cancelled`), a
//!   permission request still waiting, or another stop reason (`max_tokens`,
//!   `max_turn_requests`, `refusal`, none). An item that can't be sent pauses it
//!   too, and stays first. After a restart a queue that holds messages is paused:
//!   the turn it waited on was cut off, and nothing should reach an agent on its own
//!   the moment the app opens. "Resume queue" sends the first item (at once when no
//!   turn runs). "Send now" moves an item first and stops the running turn; it goes
//!   when that turn ends, whatever the end.
//! - **Removing** an item (Remove, Clear queue) drops its attachments: images only it
//!   held are deleted from the chat's image store. Edit takes the item out and hands
//!   its text, mentions and attachments back to the composer.

use super::{Entry, Hub, Session, SessionInfo};
use crate::attachments::Attachment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, OnceLock, Weak};

/// Messages one chat can have waiting.
pub const MAX_QUEUED: usize = 50;

#[allow(clippy::trivially_copy_pass_by_ref, reason = "serde's skip_serializing_if passes a reference")]
fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// A chat's queue, kept with the chat (in its info).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Queued>,
    /// Why the queue isn't sending; `None` while it sends as turns end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<Pause>,
    /// The id of the item that went last, so the UI can say it was sent (not kept on disk).
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub last_sent: Option<String>,
    /// "Send now": this item goes when the turn being stopped ends, whatever the end.
    #[serde(skip)]
    send_now: Option<String>,
    /// The user stopped the running turn (`Hub::cancel`).
    #[serde(skip)]
    stopping: bool,
}

/// One message waiting to be sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queued {
    pub id: String,
    pub text: String,
    /// Absolute paths of the files mentioned with `@`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    /// What the user attached, owned by the queue until the item is sent or removed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<Attachment>,
    /// How many `#` references the text has; they are read when it is sent.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub references: usize,
    /// Unix seconds.
    #[serde(default)]
    pub queued_at: u64,
    /// The chat's model and effort when it was queued (option id → value), to show.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub config: BTreeMap<String, String>,
    /// On its way: its references are read and its turn is starting (not kept on disk).
    #[serde(default, skip_deserializing, skip_serializing_if = "std::ops::Not::not")]
    pub sending: bool,
}

/// Why a queue stopped sending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    /// The turn ended with an error (the agent failed, or its process exited).
    Error,
    /// The user stopped the turn (or the agent reported it cancelled).
    Cancelled,
    /// A permission request was still waiting when the turn ended.
    Permission,
    /// The turn ended for another reason (`max_tokens`, `refusal`, …): in `detail`.
    Stopped,
    /// The app restarted with messages queued.
    Restart,
    /// The first item couldn't be sent: why in `detail`.
    SendFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    pub reason: PauseReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Pause {
    fn new(reason: PauseReason, detail: Option<&str>) -> Self {
        Self { reason, detail: detail.map(|d| super::truncate(d, 300)) }
    }
}

/// What `send_prompt` did with a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Sent {
    /// Its turn started.
    Started,
    /// The chat was busy: it waits in the queue, at `position` (1 = next).
    Queued { id: String, position: usize },
}

/// What an Edit hands back to the composer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edited {
    pub text: String,
    pub mentions: Vec<String>,
    pub files: Vec<Attachment>,
}

impl Queue {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.paused.is_none()
    }

    /// A queued message is on its way.
    pub fn sending(&self) -> bool {
        self.items.iter().any(|i| i.sending)
    }

    fn index(&self, id: &str) -> Result<usize, String> {
        self.items.iter().position(|i| i.id == id).ok_or_else(|| "That message isn't queued any more.".to_owned())
    }

    /// The item at `id`, if it can be changed (not on its way).
    fn changeable(&self, id: &str) -> Result<usize, String> {
        let i = self.index(id)?;
        if self.items[i].sending {
            return Err("That message is being sent.".into());
        }
        Ok(i)
    }

    fn push(&mut self, item: Queued) -> Result<usize, String> {
        if self.items.len() >= MAX_QUEUED {
            return Err(format!("A chat can have at most {MAX_QUEUED} messages queued."));
        }
        self.items.push(item);
        Ok(self.items.len())
    }

    /// Take out the item `id` (Edit, Remove).
    fn take(&mut self, id: &str) -> Result<Queued, String> {
        let i = self.changeable(id)?;
        let item = self.items.remove(i);
        self.after_change();
        Ok(item)
    }

    /// Move `id` to `to` (0 = next). An item on its way stays first.
    fn move_to(&mut self, id: &str, to: usize) -> Result<(), String> {
        let from = self.changeable(id)?;
        let first = usize::from(self.items.first().is_some_and(|i| i.sending));
        let to = to.clamp(first, self.items.len() - 1);
        let item = self.items.remove(from);
        self.items.insert(to, item);
        Ok(())
    }

    /// Unite every message not on its way into the first of them: texts joined by a blank
    /// line, mentions without repeats, all attachments. Returns that message's id.
    fn merge_all(&mut self) -> Result<String, String> {
        let (waiting, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.items).into_iter().partition(|i| !i.sending);
        let mut waiting = waiting.into_iter();
        let Some(mut head) = waiting.next() else {
            self.items = kept;
            return Err("There is nothing queued.".into());
        };
        for item in waiting {
            if !item.text.is_empty() {
                if !head.text.is_empty() {
                    head.text.push_str("\n\n");
                }
                head.text.push_str(&item.text);
            }
            for m in item.mentions {
                if !head.mentions.contains(&m) {
                    head.mentions.push(m);
                }
            }
            head.files.extend(item.files);
        }
        head.references = reference_count(&head.text);
        let id = head.id.clone();
        // An item on its way stays first.
        self.items = kept;
        self.items.push(head);
        Ok(id)
    }

    /// Everything not on its way; the queue sends again when something is queued.
    fn clear(&mut self) -> Vec<Queued> {
        let (gone, kept) = std::mem::take(&mut self.items).into_iter().partition(|i| !i.sending);
        self.items = kept;
        self.paused = None;
        self.send_now = None;
        gone
    }

    /// An empty queue has nothing to pause or send next.
    fn after_change(&mut self) {
        if self.items.is_empty() {
            self.paused = None;
            self.send_now = None;
        }
    }

    /// The user stopped the turn that runs now.
    pub(super) fn stopped_by_user(&mut self) {
        self.stopping = true;
    }

    /// A turn ended: whether the first item goes now. Otherwise the queue is paused
    /// (or already was); see the module's rules.
    pub(super) fn turn_ended(&mut self, stop: Option<&str>, error: Option<&str>, permission_waiting: bool) -> bool {
        let stopped = std::mem::take(&mut self.stopping);
        if self.items.is_empty() {
            self.send_now = None;
            return false;
        }
        if self.send_now.take().is_some() {
            self.paused = None;
            return true;
        }
        if self.paused.is_some() {
            return false;
        }
        self.paused = if error.is_some() {
            Some(Pause::new(PauseReason::Error, error))
        } else if stopped || stop == Some("cancelled") {
            Some(Pause::new(PauseReason::Cancelled, None))
        } else if permission_waiting {
            Some(Pause::new(PauseReason::Permission, None))
        } else if stop == Some("end_turn") {
            None
        } else {
            Some(Pause::new(PauseReason::Stopped, Some(stop.unwrap_or("no stop reason"))))
        };
        self.paused.is_none()
    }

    /// The first item, marked on its way, when the queue may send it.
    fn begin(&mut self) -> Option<Queued> {
        if self.paused.is_some() || self.sending() {
            return None;
        }
        // Everything waiting goes together, as one message.
        self.merge_all().ok()?;
        let first = self.items.first_mut()?;
        first.sending = true;
        Some(first.clone())
    }

    /// Its turn started: it leaves the queue.
    pub(super) fn sent(&mut self, id: &str) {
        self.items.retain(|i| i.id != id);
        self.last_sent = Some(id.to_owned());
        self.after_change();
    }

    /// It couldn't be sent: it stays first and the queue pauses, saying why.
    fn failed(&mut self, id: &str, why: &str) {
        if let Some(item) = self.items.iter_mut().find(|i| i.id == id) {
            item.sending = false;
            self.paused = Some(Pause::new(PauseReason::SendFailed, Some(why)));
        }
    }

    /// Read back after a restart: a queue that holds messages waits for "Resume queue".
    pub(super) fn restored(&mut self) {
        for item in &mut self.items {
            item.sending = false;
        }
        if !self.items.is_empty() && self.paused.is_none() {
            self.paused = Some(Pause::new(PauseReason::Restart, None));
        }
    }
}

/// How many distinct `#` references `text` has (`references::resolve_text` reads each once).
fn reference_count(text: &str) -> usize {
    crate::references::tokens(text).iter().map(|t| t.text().to_lowercase()).collect::<HashSet<_>>().len()
}

/// The chat's model and effort as the agent has them now.
fn picks(info: &SessionInfo) -> BTreeMap<String, String> {
    info.config.options.iter().filter(|o| o.role.is_some()).map(|o| (o.id.clone(), o.current.clone())).collect()
}

/// Every image store id the chat still uses: its transcript's and the queue's.
fn images_in_use(s: &Session) -> HashSet<String> {
    let id = |v: &Value| v["image"].as_str().map(str::to_owned);
    let mut ids = HashSet::new();
    for e in &s.entries {
        match &**e {
            Entry::User { files, .. } => ids.extend(files.iter().filter_map(|f| f.image.clone())),
            Entry::Agent { images, .. } => ids.extend(images.iter().filter_map(id)),
            Entry::Tool { content, .. } => ids.extend(content.as_array().into_iter().flatten().filter_map(|c| id(&c["content"]))),
            _ => {}
        }
    }
    for item in &s.info.queue.items {
        ids.extend(item.files.iter().filter_map(|f| f.image.clone()));
    }
    ids
}

/// Delete the images only `gone` held (not the transcript, the rest of the queue, nor
/// what `staged` says the composer still holds) from the chat's image store.
fn drop_images(s: &Session, gone: &[Queued], staged: &dyn Fn(&str) -> bool) {
    let mut candidates: Vec<&str> = gone.iter().flat_map(|i| &i.files).filter_map(|f| f.image.as_deref()).collect();
    if candidates.is_empty() {
        return;
    }
    let used = images_in_use(s);
    candidates.retain(|id| !used.contains(*id) && !staged(id));
    let dir = super::image_dir(s);
    for id in candidates {
        // Store ids are plain (a hash and an extension); anything else is never a file name here.
        if crate::attachments::load_image(&dir, id).is_ok()
            && let Err(e) = std::fs::remove_file(dir.join(id))
        {
            eprintln!("[queue] could not delete {id}: {e}");
        }
    }
}

/// What lets the queue send on its own: the Hub's own handle, and where references are read.
#[derive(Default)]
pub(super) struct Dispatch {
    me: OnceLock<Weak<Hub>>,
    #[cfg(test)]
    integrations: OnceLock<&'static crate::integrations::Integrations>,
}

impl Hub {
    /// Let queues send on their own: they need the Hub as the app holds it. Call once, after
    /// wrapping it in an `Arc`. Until then messages still queue but don't go.
    pub fn start_queues(self: &Arc<Self>) {
        let _ = self.queue.me.set(Arc::downgrade(self));
    }

    /// The Hub, for a task that outlives this call (`None` before [`Hub::start_queues`]).
    pub(super) fn me(&self) -> Option<Weak<Hub>> {
        self.queue.me.get().cloned()
    }

    #[cfg(test)]
    pub(crate) fn use_integrations(&self, i: &'static crate::integrations::Integrations) {
        let _ = self.queue.integrations.set(i);
    }

    #[cfg_attr(not(test), allow(clippy::unused_self, reason = "tests read their own trackers"))]
    fn integrations(&self) -> &'static crate::integrations::Integrations {
        #[cfg(test)]
        if let Some(i) = self.queue.integrations.get() {
            return i;
        }
        crate::integrations::Integrations::user()
    }

    /// Change the queue of `session_id` and tell the UI.
    fn with_queue<R>(&self, session_id: &str, f: impl FnOnce(&mut Session) -> Result<R, String>) -> Result<R, String> {
        self.shared.with(session_id, |s| {
            let r = f(s)?;
            self.shared.emit_info(s);
            self.shared.save(s);
            Ok(r)
        })?
    }

    /// Queue a message when the chat is busy (a turn runs, or a queued message is on its
    /// way); `None` when it isn't, and the message should be sent now.
    pub fn queue_if_busy(&self, session_id: &str, text: &str, mentions: &[String], files: &[Attachment]) -> Result<Option<Sent>, String> {
        self.shared.with(session_id, |s| {
            if !s.info.running && !s.info.queue.sending() {
                return Ok(None);
            }
            let id = super::random_token();
            let item = Queued {
                id: id.clone(),
                text: text.to_owned(),
                mentions: mentions.to_vec(),
                files: files.to_vec(),
                references: reference_count(text),
                queued_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()),
                config: picks(&s.info),
                sending: false,
            };
            let position = s.info.queue.push(item)?;
            self.shared.emit_info(s);
            self.shared.save(s);
            Ok(Some(Sent::Queued { id, position }))
        })?
    }

    /// Send a message, or queue it while the chat is busy. `send_prompt` in the app.
    pub async fn send_or_queue(&self, session_id: &str, text: String, mentions: Vec<String>, files: Vec<Attachment>) -> Result<Sent, String> {
        if let Some(queued) = self.queue_if_busy(session_id, &text, &mentions, &files)? {
            return Ok(queued);
        }
        // `github#o/r#9`, `linear#ENG-1`… in the text, read (read-only) before the turn starts.
        let references = crate::references::resolve_text(self.integrations(), &text).await;
        match self.start_turn(session_id, text.clone(), mentions.clone(), files.clone(), references, None).await {
            // A turn started while the references were read: this one waits for it.
            Err(e) if e == super::BUSY => self.queue_if_busy(session_id, &text, &mentions, &files)?.ok_or(e),
            r => r.map(|()| Sent::Started),
        }
    }

    /// Remove a queued message. Images only it held go from the chat's image store
    /// (`staged`: whether the composer still holds one).
    pub fn queue_remove(&self, session_id: &str, id: &str, staged: &dyn Fn(&str) -> bool) -> Result<SessionInfo, String> {
        self.with_queue(session_id, |s| {
            let gone = s.info.queue.take(id)?;
            drop_images(s, &[gone], staged);
            Ok(s.info.clone())
        })
    }

    /// Edit: take a queued message out, for the composer. Its attachments go with it.
    pub fn queue_take(&self, session_id: &str, id: &str) -> Result<Edited, String> {
        self.with_queue(session_id, |s| {
            let item = s.info.queue.take(id)?;
            Ok(Edited { text: item.text, mentions: item.mentions, files: item.files })
        })
    }

    /// Move a queued message to `to` (0 = next).
    pub fn queue_move(&self, session_id: &str, id: &str, to: usize) -> Result<SessionInfo, String> {
        self.with_queue(session_id, |s| {
            s.info.queue.move_to(id, to)?;
            Ok(s.info.clone())
        })
    }

    /// Clear queue: every message not already on its way, and their images.
    pub fn queue_clear(&self, session_id: &str, staged: &dyn Fn(&str) -> bool) -> Result<SessionInfo, String> {
        self.with_queue(session_id, |s| {
            let gone = s.info.queue.clear();
            drop_images(s, &gone, staged);
            Ok(s.info.clone())
        })
    }

    /// "Resume queue": it sends again, the first item at once when no turn runs.
    pub fn queue_resume(&self, session_id: &str) -> Result<SessionInfo, String> {
        let info = self.with_queue(session_id, |s| {
            s.info.queue.paused = None;
            Ok(s.info.clone())
        })?;
        if !info.running {
            self.send_next_in_background(session_id);
        }
        Ok(info)
    }

    /// "Send now": the item goes next. A running turn is stopped, and the item goes when it ends.
    pub fn queue_send_now(&self, session_id: &str, id: &str) -> Result<SessionInfo, String> {
        self.send_now(session_id, id)
    }

    /// "Join all": every waiting message is united into one, so the next send takes them together.
    pub fn queue_merge(&self, session_id: &str) -> Result<SessionInfo, String> {
        self.with_queue(session_id, |s| {
            s.info.queue.merge_all()?;
            Ok(s.info.clone())
        })
    }

    fn send_now(&self, session_id: &str, id: &str) -> Result<SessionInfo, String> {
        let info = self.with_queue(session_id, |s| {
            if s.info.queue.sending() {
                return Err("A queued message is being sent; try again in a moment.".into());
            }
            s.info.queue.move_to(id, 0)?;
            s.info.queue.paused = None;
            if s.info.running {
                s.info.queue.send_now = Some(id.to_owned());
            }
            Ok(s.info.clone())
        })?;
        if info.running {
            self.cancel(session_id)?;
        } else {
            self.send_next_in_background(session_id);
        }
        Ok(info)
    }

    /// Send the queue's first item, on a task of its own.
    pub(super) fn send_next_in_background(&self, session_id: &str) {
        let Some(hub) = self.me().and_then(|w| w.upgrade()) else { return };
        let sid = session_id.to_owned();
        tauri::async_runtime::spawn(async move { hub.send_next(&sid).await });
    }

    /// Send the queue's first item, if it may go: its references are read now, then
    /// its turn starts as any message's does. One that can't be sent pauses the queue.
    pub(super) async fn send_next(&self, session_id: &str) {
        let next = self.shared.with(session_id, |s| {
            let item = if s.info.running { None } else { s.info.queue.begin() };
            if item.is_some() {
                self.shared.emit_info(s);
            }
            item
        });
        let Ok(Some(item)) = next else { return };
        let references = crate::references::resolve_text(self.integrations(), &item.text).await;
        let started = self.start_turn(session_id, item.text.clone(), item.mentions.clone(), item.files.clone(), references, Some(&item.id)).await;
        if let Err(e) = started {
            let _ = self.with_queue(session_id, |s| {
                s.info.queue.failed(&item.id, &e);
                Ok(())
            });
        }
    }
}

#[cfg(test)]
mod tests;
