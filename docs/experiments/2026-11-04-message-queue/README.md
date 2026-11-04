# Queued messages

Messages sent while a turn runs wait in the chat's queue, and Rust sends them one at a time as each turn ends
(`app/src-tauri/src/session/queue.rs`, `app/src/components/composer-queue.tsx`). Checked in the browser mock (`pnpm dev`
on port 1438 with HMR off, so other agents' edits didn't reload the page, and `?mock-delay=6` so turns are slow enough to
queue by hand), with vitro, at 1440 × 900 in yaah light unless noted. The first message uses the mock's recorded Write
chat, which waits on a permission card, so the turn stays running while messages are queued.

1. `01-queued-while-running.png`: two messages sent with Enter while the first turn waits on its permission. The composer
   cleared each time. "2 queued" above the composer, each message on one line with Send now, Edit, Move up and down
   (the first's Move up dimmed, the last's Move down dimmed) and Remove. The second message has a `github#` reference,
   shown as "1 reference"; it isn't read yet.
2. `02-expanded.png`: a click on the first message's text shows all of it.
3. `03-paused-after-stop.png`: Stop on the running turn. The queue doesn't send on; it says "Paused: the turn was stopped"
   and offers Resume queue. (The mock leaves the cancelled permission card drawn as pending; Rust marks it cancelled.)
4. `04-next-goes-when-the-turn-ends.png`: after answering the permission, the turn ends normally (`end_turn`) and the
   first queued message leaves the queue: Rust sent it, with no click. "1 queued" is left.
5. `05-sent-in-order.png`: both queued messages went, in order, each after the last ended. The `github#acme/shop#42`
   reference was read when the message was sent (the mock has no such issue, so it's marked "Couldn't read … Sent without
   its details").
6. `06-palette-clear-queue.png`: ⌘K, typing "queue": "Clear queue · 2 queued" while the chat has a queue (it isn't
   listed when the queue is empty).
7. `07-dark-narrow.png`: yaah dark at 820 × 760: the queue above the composer, with long texts cut to one line.
8. `08-send-now.png`: Send now on the second of two queued messages. It stopped the running turn ("Write the changelog
   entry too"), went first ("And post the PR link…"), and the other queued message followed when that turn ended.

Notes:

- vitro's `type_text` puts text in the box without pressing Enter, so each message was typed and then sent with an
  explicit Enter key press.
- One capture after clicking Send now showed the pane scrolled half off screen for a frame; the next capture a moment later
  was laid out normally (vitro scrolls the clicked element into the centre first). It isn't shown.
- Two mock fixes made the turns faithful to Rust here: `send_prompt` marks the chat running at once (as `Hub::start_turn`
  does), and a recording's opening "not running" info, the chat as it was created, is skipped. Before them a message sent
  in the first seconds of a turn replaced that turn instead of queuing.
