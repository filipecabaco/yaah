//! Attachments: images, files and folders the user drops, pastes or picks into
//! a chat's composer, and the images agents send back.
//!
//! The UI only ever hands over what the user gave it: paths from a drop or the
//! file picker, or the bytes of a pasted image. Nothing here follows a path an
//! agent wrote. Each path is read here, once, when it is attached: the type is
//! sniffed from its bytes (the extension is only a fallback), images are held
//! to [`MAX_IMAGE_BYTES`] and [`MAX_IMAGE_SIDE`] (downscaled only when past
//! them), and the bytes as they will be sent are kept in the chat's image store.
//! At send, [`blocks`] turns them into ACP content for what the agent says it
//! takes (`promptCapabilities`): `image` blocks, embedded text `resource`s for
//! small text files, `resource_link`s for everything else (the ACP baseline).
//!
//! The image store (`~/.yaah/sessions/<chat>.images/`) keeps image bytes out of
//! the transcript: an entry holds an id (a hash of the bytes) and the UI asks
//! for the bytes with [`read_image`]. Agents' images (a browser screenshot in a
//! tool result) go there too ([`externalize_content`]), so a chat with many
//! screenshots doesn't carry megabytes of base64 in every save and re-render.

use crate::agents::Report;
use crate::session::Hub;
use base64::Engine;
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

const KB: u64 = 1024;
const MB: u64 = 1024 * KB;

/// Largest image sent to an agent, in bytes (Anthropic's API refuses larger ones).
pub const MAX_IMAGE_BYTES: u64 = 5 * MB;
/// Longest side sent, in pixels (also an API limit).
pub const MAX_IMAGE_SIDE: u32 = 8000;
/// What a downscaled image's longer side becomes: plenty for a model to read a screenshot.
pub const DOWNSCALE_TO: u32 = 2048;
/// Largest image file read to downscale; past this it's refused before it's read.
pub const MAX_IMAGE_INPUT: u64 = 50 * MB;
/// All images in one message, as sent.
pub const MAX_IMAGES_TOTAL: u64 = 20 * MB;
/// Text files up to this size go inline (an embedded `resource`) to agents that take them.
pub const MAX_EMBED_TEXT: u64 = 64 * KB;
/// Attachments in one message.
pub const MAX_ATTACHMENTS: usize = 20;
/// Largest image an agent sends that is kept to show; past it the image is left out, with why.
pub const MAX_AGENT_IMAGE: u64 = 20 * MB;
/// Bytes read to tell what a file is.
const SNIFF: usize = 8 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Image,
    File,
    Folder,
}

/// How an attachment went to the agent.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SentAs {
    /// An ACP `image` block.
    Image,
    /// An embedded `resource` with the file's text.
    Embedded,
    /// A `resource_link` to the file or folder.
    Link,
}

/// One attachment: in the composer while it waits to be sent, and in the user's
/// message (`Entry::User.files`) once it was.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Bytes, as sent (a downscaled image's new size). `None` for a folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Where it is on disk: what the user attached, or the image store's copy of a pasted image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Pasted: there was no file. Nothing to reveal.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pasted: bool,
    /// The image in the chat's image store ([`read_image`]), for images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Something the user should know, e.g. "Downscaled from 9000 × 6000".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// UTF-8 text small enough to embed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub text: bool,
    /// Set once sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_as: Option<SentAs>,
}

/// Something that couldn't be attached, and why, in words for the user.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub added: Vec<Attachment>,
    pub refused: Vec<Refused>,
}

/// A dragged path as the drop overlay describes it, from its metadata and name only (nothing is read).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Described {
    pub name: String,
    pub kind: Kind,
}

fn name_of(path: &Path) -> String {
    path.file_name().map_or_else(|| path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

fn megabytes(n: u64) -> String {
    #[allow(clippy::cast_precision_loss, reason = "a size shown to one decimal")]
    let mb = n as f64 / MB as f64;
    if mb >= 10.0 { format!("{mb:.0} MB") } else { format!("{mb:.1} MB") }
}

/// The image formats an agent can take, by their bytes.
fn image_format(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok().filter(|f| matches!(f, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP))
}

fn format_mime(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => "image/png",
    }
}

fn format_ext(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        _ => "png",
    }
}

/// Text: no NUL and valid UTF-8 (a character cut at the end of the sample is fine).
fn looks_like_text(sample: &[u8]) -> bool {
    if sample.contains(&0) {
        return false;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && sample.len() - e.valid_up_to() < 4,
    }
}

/// The type of a file from its first bytes, the name only telling text formats apart.
pub fn sniff_mime(sample: &[u8], name: &str) -> (String, bool) {
    if let Some(f) = image_format(sample) {
        return (format_mime(f).to_owned(), false);
    }
    if looks_like_text(sample) {
        let ext = Path::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        let mime = match ext.as_str() {
            "md" | "markdown" => "text/markdown",
            "json" => "application/json",
            "csv" => "text/csv",
            "html" | "htm" => "text/html",
            "css" => "text/css",
            "js" | "mjs" | "cjs" | "jsx" => "text/javascript",
            "ts" | "tsx" => "text/x-typescript",
            "rs" => "text/x-rust",
            "py" => "text/x-python",
            "svg" => "image/svg+xml",
            "xml" => "application/xml",
            "yaml" | "yml" => "application/yaml",
            "toml" => "application/toml",
            _ => "text/plain",
        };
        return (mime.to_owned(), true);
    }
    let mime = infer::get(sample).map_or("application/octet-stream", |t| t.mime_type());
    (mime.to_owned(), false)
}

/// What a drag holds, for the overlay: folders by their metadata, the rest by name.
pub fn describe(paths: &[String]) -> Vec<Described> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let kind = if path.is_dir() {
                Kind::Folder
            } else {
                let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") { Kind::Image } else { Kind::File }
            };
            Described { name: name_of(path), kind }
        })
        .collect()
}

/// An image ready to send: its bytes, format and size, downscaled if it was past the limits.
#[derive(Debug)]
pub struct Prepared {
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
    pub note: Option<String>,
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(40_000);
    l.max_image_height = Some(40_000);
    l.max_alloc = Some(1024 * MB);
    l
}

/// Hold an image to [`MAX_IMAGE_BYTES`] and [`MAX_IMAGE_SIDE`]: as it is when it fits,
/// else downscaled to [`DOWNSCALE_TO`] and re-encoded (PNG with transparency, else JPEG).
pub fn prepare_image(bytes: Vec<u8>, name: &str) -> Result<Prepared, String> {
    let format = image_format(&bytes).ok_or_else(|| format!("{name} isn't a PNG, JPEG, GIF or WebP image"))?;
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits());
    let (width, height) = reader.into_dimensions().map_err(|e| format!("{name} can't be read as an image ({e})"))?;
    if bytes.len() as u64 <= MAX_IMAGE_BYTES && width.max(height) <= MAX_IMAGE_SIDE {
        return Ok(Prepared { bytes, format, width, height, note: None });
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits());
    let img = reader.decode().map_err(|e| format!("{name} can't be read as an image ({e})"))?;
    let img = if width.max(height) > DOWNSCALE_TO { img.resize(DOWNSCALE_TO, DOWNSCALE_TO, image::imageops::FilterType::Triangle) } else { img };
    let alpha = img.color().has_alpha();
    let mut out = Cursor::new(Vec::new());
    let out_format = if alpha {
        img.write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
        ImageFormat::Png
    } else {
        let rgb = img.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&rgb).map_err(|e| e.to_string())?;
        ImageFormat::Jpeg
    };
    let bytes = out.into_inner();
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(format!("{name} is still over {} after downscaling", megabytes(MAX_IMAGE_BYTES)));
    }
    let (w, h) = (img.width(), img.height());
    let note = if (w, h) == (width, height) {
        format!("Re-encoded to fit {}", megabytes(MAX_IMAGE_BYTES))
    } else {
        format!("Downscaled from {width} × {height}")
    };
    Ok(Prepared { bytes, format: out_format, width: w, height: h, note: Some(note) })
}

// ---------------------------------------------------------------------------
// The image store

/// Where a chat keeps its images: beside its transcript, else (a chat that isn't
/// saved, in tests) a folder of its own under the temp folder.
pub fn image_dir(save_to: Option<&Path>, session_id: &str) -> PathBuf {
    save_to.map_or_else(
        || {
            let safe: String = session_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            std::env::temp_dir().join("yaah-images").join(safe)
        },
        |p| p.with_extension("images"),
    )
}

/// `<32 hex>.<ext>`: what [`store_image`] returns, and all [`load_image`] accepts.
fn valid_id(id: &str) -> Option<&'static str> {
    let (hash, ext) = id.split_once('.')?;
    if hash.len() != 32 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    Some(match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// Keep `bytes` in `dir` under a name from their hash (the same image is kept once). Returns its id.
pub fn store_image(dir: &Path, bytes: &[u8], format: ImageFormat) -> Result<String, String> {
    let hash = Sha256::digest(bytes);
    let hex = hash.iter().take(16).fold(String::with_capacity(32), |mut out, b| {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
        out
    });
    let id = format!("{hex}.{}", format_ext(format));
    let path = dir.join(&id);
    if path.is_file() {
        return Ok(id);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't keep the image ({e})"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let tmp = dir.join(format!(".{id}.{}", crate::random::token()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("couldn't keep the image ({e})"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("couldn't keep the image ({e})"))?;
    Ok(id)
}

/// An image from the chat's store, and its type.
pub fn load_image(dir: &Path, id: &str) -> Result<(Vec<u8>, &'static str), String> {
    let mime = valid_id(id).ok_or("not an image id")?;
    let bytes = std::fs::read(dir.join(id)).map_err(|_| "this image is no longer kept".to_owned())?;
    Ok((bytes, mime))
}

// ---------------------------------------------------------------------------
// Attaching

/// Attach what's at `path` (dropped or picked): its type, size and, for an image, its bytes as
/// they'll be sent, kept in `images`.
pub fn attach_path(path: &str, images: &Path) -> Result<Attachment, Refused> {
    let p = Path::new(path);
    let name = name_of(p);
    let refuse = |reason: String| Refused { name: name.clone(), reason };
    if !p.is_absolute() {
        return Err(refuse("isn't a full path".into()));
    }
    let meta = std::fs::metadata(p).map_err(|_| refuse("can't be found".into()))?;
    let base = Attachment {
        id: crate::random::token(),
        name: name.clone(),
        kind: Kind::File,
        mime_type: None,
        size: None,
        path: Some(path.to_owned()),
        pasted: false,
        image: None,
        width: None,
        height: None,
        note: None,
        text: false,
        sent_as: None,
    };
    if meta.is_dir() {
        return Ok(Attachment { kind: Kind::Folder, ..base });
    }
    if !meta.is_file() {
        return Err(refuse("isn't a file or a folder".into()));
    }
    let mut sample = vec![0; SNIFF];
    let n = {
        use std::io::Read;
        let mut f = std::fs::File::open(p).map_err(|e| refuse(format!("can't be read ({e})")))?;
        let mut n = 0;
        while n < SNIFF {
            match f.read(&mut sample[n..]) {
                Ok(0) => break,
                Ok(k) => n += k,
                Err(e) => return Err(refuse(format!("can't be read ({e})"))),
            }
        }
        n
    };
    sample.truncate(n);
    if image_format(&sample).is_some() {
        if meta.len() > MAX_IMAGE_INPUT {
            return Err(refuse(format!("is {}; images over {} can't be attached", megabytes(meta.len()), megabytes(MAX_IMAGE_INPUT))));
        }
        let bytes = std::fs::read(p).map_err(|e| refuse(format!("can't be read ({e})")))?;
        let img = prepare_image(bytes, &name)
            .map_err(|reason| Refused { name: name.clone(), reason: reason.trim_start_matches(&name).trim().to_owned() })?;
        let id = store_image(images, &img.bytes, img.format).map_err(refuse)?;
        return Ok(Attachment {
            kind: Kind::Image,
            mime_type: Some(format_mime(img.format).to_owned()),
            size: Some(img.bytes.len() as u64),
            image: Some(id),
            width: Some(img.width),
            height: Some(img.height),
            note: img.note,
            ..base
        });
    }
    let (mime, text) = sniff_mime(&sample, &name);
    Ok(Attachment { mime_type: Some(mime), size: Some(meta.len()), text: text && meta.len() <= MAX_EMBED_TEXT, ..base })
}

/// Attach a pasted image (its bytes; there's no file): kept in `images`, which is also the file
/// an agent without image support is linked to.
pub fn attach_pasted(bytes: Vec<u8>, name: Option<&str>, images: &Path) -> Result<Attachment, Refused> {
    let format = image_format(&bytes);
    let name = name.map(str::trim).filter(|n| !n.is_empty()).map_or_else(
        || format!("Pasted image.{}", format.map_or("png", format_ext)),
        |n| name_of(Path::new(n)), // a name, never a path
    );
    let refuse = |reason: String| Refused { name: name.clone(), reason };
    if format.is_none() {
        return Err(refuse("isn't a PNG, JPEG, GIF or WebP image".into()));
    }
    if bytes.len() as u64 > MAX_IMAGE_INPUT {
        return Err(refuse(format!("is {}; images over {} can't be attached", megabytes(bytes.len() as u64), megabytes(MAX_IMAGE_INPUT))));
    }
    let img = prepare_image(bytes, &name).map_err(|reason| refuse(reason.trim_start_matches(&name).trim().to_owned()))?;
    let id = store_image(images, &img.bytes, img.format).map_err(refuse)?;
    Ok(Attachment {
        id: crate::random::token(),
        name,
        kind: Kind::Image,
        mime_type: Some(format_mime(img.format).to_owned()),
        size: Some(img.bytes.len() as u64),
        path: Some(images.join(&id).to_string_lossy().into_owned()),
        pasted: true,
        image: Some(id),
        width: Some(img.width),
        height: Some(img.height),
        note: img.note,
        text: false,
        sent_as: None,
    })
}

/// A `file://` URI for an absolute path, as the existing `@` mentions send them.
pub fn file_uri(path: &str) -> String {
    format!("file://{path}")
}

/// The ACP blocks for `items`, for an agent with `caps`, and the attachments as sent.
/// Images go as `image` blocks to agents that take images; small text files are embedded for
/// agents that take embedded context; everything else is a `resource_link`.
pub fn blocks(items: &[Attachment], caps: &Report, images: &Path) -> Result<(Vec<Value>, Vec<Attachment>), String> {
    if items.len() > MAX_ATTACHMENTS {
        return Err(format!("A message takes at most {MAX_ATTACHMENTS} attachments"));
    }
    let total: u64 = items.iter().filter(|a| a.kind == Kind::Image).filter_map(|a| a.size).sum();
    if caps.image && total > MAX_IMAGES_TOTAL {
        return Err(format!("The images add up to {}; one message takes at most {}", megabytes(total), megabytes(MAX_IMAGES_TOTAL)));
    }
    let mut out = Vec::with_capacity(items.len());
    let mut sent = Vec::with_capacity(items.len());
    for a in items {
        let uri = a.path.as_deref().map(file_uri);
        let link = |a: &Attachment| {
            let mut b = json!({ "type": "resource_link", "uri": uri.clone().unwrap_or_default(), "name": a.name });
            if let Some(m) = &a.mime_type {
                b["mimeType"] = json!(m);
            }
            if let Some(s) = a.size {
                b["size"] = json!(s);
            }
            if a.kind == Kind::Folder {
                b["description"] = json!("A folder");
            }
            b
        };
        let (block, how) = match a.kind {
            Kind::Image if caps.image => {
                let id = a.image.as_deref().ok_or_else(|| format!("{} has no image to send", a.name))?;
                let (bytes, mime) = load_image(images, id).map_err(|e| format!("{}: {e}; attach it again", a.name))?;
                let mut b = json!({ "type": "image", "mimeType": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes) });
                if let Some(u) = &uri {
                    b["uri"] = json!(u);
                }
                (b, SentAs::Image)
            }
            Kind::File if a.text && caps.embedded_context => match a.path.as_deref().and_then(read_small_text) {
                Some(text) => (
                    json!({ "type": "resource", "resource": { "uri": uri.clone().unwrap_or_default(), "mimeType": a.mime_type.as_deref().unwrap_or("text/plain"), "text": text } }),
                    SentAs::Embedded,
                ),
                None => (link(a), SentAs::Link),
            },
            _ => (link(a), SentAs::Link),
        };
        if uri.is_none() && how == SentAs::Link {
            return Err(format!("{} has no file to link to; attach it again", a.name));
        }
        out.push(block);
        sent.push(Attachment { sent_as: Some(how), ..a.clone() });
    }
    Ok((out, sent))
}

/// The file's text if it is still small and UTF-8 (it is read again at send: it may have changed).
fn read_small_text(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_EMBED_TEXT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

// ---------------------------------------------------------------------------
// Agents' images

/// An ACP image block an agent sent (`{type: "image", data, mimeType}`), with its bytes moved
/// to the store: `{type: "image", mimeType, image: <id>, size, width, height}` (its `uri` kept).
/// One too large to keep becomes `{type: "image", mimeType, omitted: <why>}`. Anything else is left as it is.
pub fn externalize_block(block: &mut Value, images: &Path) {
    if block["type"] != "image" {
        return;
    }
    let Some(data) = block["data"].as_str() else { return };
    // base64 is 4 bytes per 3.
    let approx = (data.len() as u64 / 4) * 3;
    let mime = block["mimeType"].as_str().unwrap_or("image/png").to_owned();
    let uri = block.get("uri").cloned();
    let replace = |fields: Value| {
        let mut v = fields;
        if let Some(u) = &uri {
            v["uri"] = u.clone();
        }
        v
    };
    if approx > MAX_AGENT_IMAGE {
        *block = replace(
            json!({ "type": "image", "mimeType": mime, "omitted": format!("An image of {} was left out; images over {} aren't kept", megabytes(approx), megabytes(MAX_AGENT_IMAGE)) }),
        );
        return;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) else {
        *block = replace(json!({ "type": "image", "mimeType": mime, "omitted": "The agent sent an image that couldn't be read" }));
        return;
    };
    let Some(format) = image_format(&bytes) else {
        *block = replace(json!({ "type": "image", "mimeType": mime, "omitted": "The agent sent an image in a format yaah can't show" }));
        return;
    };
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits());
    let dims = reader.into_dimensions().ok();
    match store_image(images, &bytes, format) {
        Ok(id) => {
            let mut v = json!({ "type": "image", "mimeType": format_mime(format), "image": id, "size": bytes.len() });
            if let Some((w, h)) = dims {
                v["width"] = json!(w);
                v["height"] = json!(h);
            }
            *block = replace(v);
        }
        Err(e) => eprintln!("[attachments] an agent's image wasn't kept: {e}"),
    }
}

/// A tool call's `content` with each image's bytes moved to the store ([`externalize_block`]).
pub fn externalize_content(content: &mut Value, images: &Path) {
    for item in content.as_array_mut().into_iter().flatten() {
        if item["type"] == "content" {
            externalize_block(&mut item["content"], images);
        }
    }
}

// ---------------------------------------------------------------------------
// What the composer holds

/// What each chat's composer has attached and not sent yet. Only what the UI got from
/// the user (a drop, the picker, a paste) gets here; sending looks it up by id.
#[derive(Default)]
pub struct Staging {
    items: Mutex<HashMap<String, (String, Attachment)>>,
}

impl Staging {
    fn of(&self, session_id: &str) -> Vec<Attachment> {
        self.items.lock().unwrap().values().filter(|(s, _)| s == session_id).map(|(_, a)| a.clone()).collect()
    }

    /// Keep `found` for the chat, refusing what would go past a message's limits or is already there.
    fn add(&self, session_id: &str, found: Vec<Result<Attachment, Refused>>) -> Staged {
        let mut out = Staged::default();
        let mut have = self.of(session_id);
        let mut items = self.items.lock().unwrap();
        for r in found {
            match r {
                Err(refused) => out.refused.push(refused),
                Ok(a) => {
                    let image_total: u64 = have.iter().filter(|h| h.kind == Kind::Image).filter_map(|h| h.size).sum();
                    let reason = if have.len() >= MAX_ATTACHMENTS {
                        Some(format!("a message takes at most {MAX_ATTACHMENTS} attachments"))
                    } else if have.iter().any(|h| h.path.is_some() && h.path == a.path && !a.pasted) {
                        Some("is already attached".to_owned())
                    } else if a.kind == Kind::Image && image_total + a.size.unwrap_or(0) > MAX_IMAGES_TOTAL {
                        Some(format!("would take this message's images past {}", megabytes(MAX_IMAGES_TOTAL)))
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        out.refused.push(Refused { name: a.name, reason });
                        continue;
                    }
                    items.insert(a.id.clone(), (session_id.to_owned(), a.clone()));
                    have.push(a.clone());
                    out.added.push(a);
                }
            }
        }
        out
    }

    /// The attachments with these ids, in order. Unknown ones are an error: the UI only sends what it attached.
    pub fn get(&self, session_id: &str, ids: &[String]) -> Result<Vec<Attachment>, String> {
        let items = self.items.lock().unwrap();
        ids.iter()
            .map(|id| match items.get(id) {
                Some((s, a)) if s == session_id => Ok(a.clone()),
                _ => Err("an attachment is no longer there; attach it again".to_owned()),
            })
            .collect()
    }

    pub fn remove(&self, ids: &[String]) {
        let mut items = self.items.lock().unwrap();
        for id in ids {
            items.remove(id);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
//
// Tauri hands commands their arguments and state by value.

/// What a drag over a chat holds, for its overlay ("Drop to attach 2 images and 1 file").
#[tauri::command]
#[allow(clippy::needless_pass_by_value, reason = "a Tauri command")]
pub fn describe_drop(paths: Vec<String>) -> Vec<Described> {
    describe(&paths)
}

/// Attach dropped or picked paths to a chat's composer.
#[tauri::command]
pub async fn stage_attachments(
    hub: State<'_, Arc<Hub>>,
    staging: State<'_, Staging>,
    session_id: String,
    paths: Vec<String>,
) -> Result<Staged, String> {
    let dir = hub.image_dir(&session_id)?;
    let found = tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| attach_path(p, &dir)).collect::<Vec<_>>())
        .await
        .map_err(|e| e.to_string())?;
    Ok(staging.add(&session_id, found))
}

/// A header the UI set, percent-decoded (`encodeURIComponent`).
fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Attach a pasted image: its bytes are the request's body, the chat and the name its
/// `x-yaah-session` and `x-yaah-name` headers.
#[tauri::command]
pub async fn stage_pasted_image(request: tauri::ipc::Request<'_>, hub: State<'_, Arc<Hub>>, staging: State<'_, Staging>) -> Result<Staged, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the image's bytes".into()) };
    let session_id = header(&request, "x-yaah-session").ok_or("no chat given")?;
    let name = header(&request, "x-yaah-name");
    let dir = hub.image_dir(&session_id)?;
    let bytes = bytes.clone();
    let found = tauri::async_runtime::spawn_blocking(move || attach_pasted(bytes, name.as_deref(), &dir)).await.map_err(|e| e.to_string())?;
    Ok(staging.add(&session_id, vec![found]))
}

/// The composer let go of these attachments (× on a chip).
#[tauri::command]
#[allow(clippy::needless_pass_by_value, reason = "a Tauri command")]
pub fn discard_attachments(staging: State<'_, Staging>, ids: Vec<String>) {
    staging.remove(&ids);
}

/// An image from a chat's store, as raw bytes (the UI makes a `blob:` URL of them).
#[tauri::command]
pub async fn read_image(hub: State<'_, Arc<Hub>>, session_id: String, id: String) -> Result<tauri::ipc::Response, String> {
    let dir = hub.image_dir(&session_id)?;
    let (bytes, _) = tauri::async_runtime::spawn_blocking(move || load_image(&dir, &id)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("yaah-attach-{tag}-{}", crate::random::token()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn byte(n: u32) -> u8 {
        u8::try_from(n % 256).unwrap()
    }

    fn png(w: u32, h: u32, alpha: bool) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        if alpha {
            image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([byte(x), byte(y), 7, 128])).write_to(&mut out, ImageFormat::Png).unwrap();
        } else {
            image::RgbImage::from_fn(w, h, |x, y| image::Rgb([byte(x), byte(y), 7])).write_to(&mut out, ImageFormat::Png).unwrap();
        }
        out.into_inner()
    }

    /// Noise compresses badly, so a modest image is many megabytes as PNG.
    fn noisy_png(width: u32, height: u32) -> Vec<u8> {
        let mut seed = 0x2545_f491_u32;
        let img = image::RgbImage::from_fn(width, height, |_, _| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let [red, green, blue, _] = seed.to_le_bytes();
            image::Rgb([red, green, blue])
        });
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn caps(image: bool, embedded_context: bool) -> Report {
        let init =
            json!({ "protocolVersion": 1, "agentCapabilities": { "promptCapabilities": { "image": image, "embeddedContext": embedded_context } } });
        Report::from_initialize(&init)
    }

    #[test]
    fn types_come_from_the_bytes_not_the_name() {
        let dir = temp("sniff");
        // A PNG named .txt is an image; text named .png is text.
        std::fs::write(dir.join("shot.txt"), png(4, 3, false)).unwrap();
        std::fs::write(dir.join("notes.png"), "just words\n").unwrap();
        std::fs::write(dir.join("doc.pdf"), b"%PDF-1.7\n\x00\x01binary").unwrap();
        std::fs::write(dir.join("blob"), [0u8, 159, 146, 150, 0, 1]).unwrap();
        let store = dir.join("store");
        let a = attach_path(dir.join("shot.txt").to_str().unwrap(), &store).unwrap();
        assert_eq!((a.kind, a.mime_type.as_deref(), a.width, a.height), (Kind::Image, Some("image/png"), Some(4), Some(3)));
        assert!(store.join(a.image.as_deref().unwrap()).is_file(), "the image is kept in the store");
        let t = attach_path(dir.join("notes.png").to_str().unwrap(), &store).unwrap();
        assert_eq!((t.kind, t.mime_type.as_deref(), t.text), (Kind::File, Some("text/plain"), true));
        let p = attach_path(dir.join("doc.pdf").to_str().unwrap(), &store).unwrap();
        assert_eq!((p.mime_type.as_deref(), p.text), (Some("application/pdf"), false));
        let b = attach_path(dir.join("blob").to_str().unwrap(), &store).unwrap();
        assert_eq!(b.mime_type.as_deref(), Some("application/octet-stream"));
        assert_eq!(sniff_mime(b"# Title\n", "README.md").0, "text/markdown");
        assert_eq!(sniff_mime("caf\u{e9}".as_bytes(), "x").0, "text/plain");
        // A sample cut inside a multi-byte character is still text.
        assert!(looks_like_text(&"aé".as_bytes()[..2]));
    }

    #[test]
    fn folders_missing_and_relative_paths() {
        let dir = temp("folders");
        let f = attach_path(dir.to_str().unwrap(), &dir.join("store")).unwrap();
        assert_eq!((f.kind, f.size), (Kind::Folder, None));
        assert_eq!(attach_path(dir.join("gone").to_str().unwrap(), &dir).unwrap_err().reason, "can't be found");
        assert_eq!(attach_path("relative/x.png", &dir).unwrap_err().reason, "isn't a full path");
        let d = describe(&[dir.to_string_lossy().into_owned(), "/x/Shot.PNG".into(), "/x/a.rs".into()]);
        assert_eq!(d.iter().map(|d| d.kind).collect::<Vec<_>>(), [Kind::Folder, Kind::Image, Kind::File]);
        assert_eq!(d[1].name, "Shot.PNG");
    }

    #[test]
    fn small_images_are_sent_as_they_are() {
        let bytes = png(640, 480, false);
        let p = prepare_image(bytes.clone(), "a.png").unwrap();
        assert_eq!((p.bytes, p.width, p.height, p.note), (bytes, 640, 480, None));
    }

    #[test]
    fn images_past_the_side_limit_are_downscaled() {
        let p = prepare_image(png(MAX_IMAGE_SIDE + 100, 50, false), "wide.png").unwrap();
        assert_eq!((p.width, p.format), (DOWNSCALE_TO, ImageFormat::Jpeg));
        assert!(p.height < 50 && p.height > 0);
        assert_eq!(p.note.as_deref(), Some("Downscaled from 8100 × 50"));
        // Transparency keeps PNG.
        let p = prepare_image(png(MAX_IMAGE_SIDE + 1, 10, true), "alpha.png").unwrap();
        assert_eq!(p.format, ImageFormat::Png);
    }

    #[test]
    fn images_past_the_byte_limit_are_downscaled_and_fit() {
        let big = noisy_png(2400, 1400);
        assert!(big.len() as u64 > MAX_IMAGE_BYTES, "the fixture is over the limit: {}", big.len());
        let p = prepare_image(big, "noise.png").unwrap();
        assert!(p.bytes.len() as u64 <= MAX_IMAGE_BYTES);
        assert_eq!(p.width, DOWNSCALE_TO);
        assert!(p.note.unwrap().starts_with("Downscaled from 2400 × 1400"));
    }

    #[test]
    fn huge_and_broken_images_are_refused_with_a_reason() {
        let dir = temp("refuse");
        let path = dir.join("huge.png");
        let mut bytes = png(2, 2, false);
        bytes.resize(usize::try_from(MAX_IMAGE_INPUT).unwrap() + 1, 0);
        std::fs::write(&path, &bytes).unwrap();
        let r = attach_path(path.to_str().unwrap(), &dir).unwrap_err();
        assert_eq!(r.name, "huge.png");
        assert!(r.reason.contains("images over 50 MB can't be attached"), "{}", r.reason);
        // PNG magic with nothing behind it.
        let broken = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        assert!(prepare_image(broken, "b.png").unwrap_err().contains("can't be read as an image"));
        assert_eq!(attach_pasted(b"plain text".to_vec(), None, &dir).unwrap_err().reason, "isn't a PNG, JPEG, GIF or WebP image");
    }

    #[test]
    fn pasted_images_are_kept_and_linked_from_the_store() {
        let dir = temp("paste");
        let a = attach_pasted(png(3, 3, false), Some("../../etc/Screenshot.png"), &dir).unwrap();
        assert_eq!(a.name, "Screenshot.png", "a pasted name is a name, never a path");
        assert!(a.pasted);
        assert_eq!(a.path.as_deref(), Some(dir.join(a.image.as_deref().unwrap()).to_str().unwrap()));
        let unnamed = attach_pasted(png(3, 3, false), None, &dir).unwrap();
        assert_eq!(unnamed.name, "Pasted image.png");
        assert_eq!(unnamed.image, a.image, "the same bytes are kept once");
    }

    #[test]
    fn the_store_accepts_only_its_own_ids() {
        let dir = temp("store");
        let id = store_image(&dir, &png(1, 1, false), ImageFormat::Png).unwrap();
        assert_eq!(load_image(&dir, &id).unwrap().1, "image/png");
        for bad in ["../x.png", "abc.png", &id.replace(".png", ".txt"), &format!("../{id}"), "/etc/passwd"] {
            assert!(load_image(&dir, bad).is_err(), "{bad}");
        }
        assert_eq!(load_image(&dir, &id.replace('0', "1").replace('a', "b")).unwrap_err(), "this image is no longer kept");
    }

    fn staged(dir: &Path) -> Vec<Attachment> {
        std::fs::write(dir.join("shot.png"), png(8, 8, false)).unwrap();
        std::fs::write(dir.join("notes.md"), "# Notes\nhello").unwrap();
        std::fs::write(dir.join("big.log"), "x".repeat(usize::try_from(MAX_EMBED_TEXT).unwrap() + 1)).unwrap();
        let store = dir.join("store");
        ["shot.png", "notes.md", "big.log", ""]
            .iter()
            .map(|n| attach_path(dir.join(n).to_str().unwrap().trim_end_matches('/'), &store).unwrap())
            .collect()
    }

    #[test]
    fn blocks_follow_the_agents_capabilities() {
        let dir = temp("blocks");
        let items = staged(&dir);
        let store = dir.join("store");
        let p = |n: &str| file_uri(dir.join(n).to_str().unwrap());

        // Images and embedded context: an image block, the small text inline, the rest linked.
        let (b, sent) = blocks(&items, &caps(true, true), &store).unwrap();
        assert_eq!(b[0]["type"], "image");
        assert_eq!(b[0]["mimeType"], "image/png");
        assert_eq!(b[0]["uri"], p("shot.png"));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(b[0]["data"].as_str().unwrap()).unwrap(), png(8, 8, false));
        assert_eq!(b[1], json!({ "type": "resource", "resource": { "uri": p("notes.md"), "mimeType": "text/markdown", "text": "# Notes\nhello" } }));
        assert_eq!(b[2]["type"], "resource_link", "too big to embed");
        assert_eq!(b[2]["size"], MAX_EMBED_TEXT + 1);
        assert_eq!(b[3]["type"], "resource_link");
        assert_eq!(b[3]["description"], "A folder");
        assert_eq!(sent.iter().map(|a| a.sent_as.unwrap()).collect::<Vec<_>>(), [SentAs::Image, SentAs::Embedded, SentAs::Link, SentAs::Link]);

        // Neither: everything is a link, the image to its file.
        let (b, sent) = blocks(&items, &caps(false, false), &store).unwrap();
        assert!(b.iter().all(|b| b["type"] == "resource_link"), "{b:?}");
        assert_eq!(
            b[0],
            json!({ "type": "resource_link", "uri": p("shot.png"), "name": "shot.png", "mimeType": "image/png", "size": items[0].size })
        );
        assert!(sent.iter().all(|a| a.sent_as == Some(SentAs::Link)));
    }

    #[test]
    fn a_pasted_image_without_image_support_links_to_the_stored_copy() {
        let dir = temp("paste-link");
        let a = attach_pasted(png(2, 2, false), None, &dir).unwrap();
        let (b, _) = blocks(std::slice::from_ref(&a), &caps(false, true), &dir).unwrap();
        assert_eq!(b[0]["uri"], file_uri(dir.join(a.image.unwrap()).to_str().unwrap()));
    }

    #[test]
    fn staging_keeps_each_chats_own_and_enforces_the_limits() {
        let dir = temp("staging");
        let items = staged(&dir);
        let staging = Staging::default();
        let out = staging.add("a", items.iter().cloned().map(Ok).collect());
        assert_eq!((out.added.len(), out.refused.len()), (4, 0));
        let again = staging.add("a", vec![Ok(Attachment { id: "other".into(), ..items[1].clone() })]);
        assert_eq!(again.refused, [Refused { name: "notes.md".into(), reason: "is already attached".into() }]);
        let ids: Vec<String> = out.added.iter().map(|a| a.id.clone()).collect();
        assert_eq!(staging.get("a", &ids).unwrap().len(), 4);
        assert!(staging.get("b", &ids).is_err(), "another chat can't send them");
        staging.remove(&ids[..1]);
        assert!(staging.get("a", &ids).is_err());

        // The images of one message add up to at most MAX_IMAGES_TOTAL.
        let image =
            |n: u64| Ok(Attachment { id: format!("i{n}"), path: Some(format!("/x/{n}.png")), size: Some(MAX_IMAGE_BYTES), ..items[0].clone() });
        let out = staging.add("c", (0..5).map(image).collect());
        assert_eq!(out.added.len(), 4);
        assert!(out.refused[0].reason.contains("past 20 MB"), "{:?}", out.refused);
        let many = staging.add(
            "d",
            (0..=MAX_ATTACHMENTS as u64).map(|n| Ok(Attachment { id: format!("f{n}"), path: Some(format!("/x/{n}")), ..items[1].clone() })).collect(),
        );
        assert_eq!(many.added.len(), MAX_ATTACHMENTS);
        assert_eq!(many.refused[0].reason, "a message takes at most 20 attachments");
    }

    #[test]
    fn agents_images_move_to_the_store() {
        let dir = temp("agent");
        let data = base64::engine::general_purpose::STANDARD.encode(png(5, 4, false));
        let mut content = json!([
            { "type": "content", "content": { "type": "text", "text": "Took a screenshot" } },
            { "type": "content", "content": { "type": "image", "mimeType": "image/png", "data": data } },
            { "type": "content", "content": { "type": "image", "mimeType": "image/png", "data": "!!not base64" } },
            { "type": "diff", "path": "/x", "newText": "" }
        ]);
        externalize_content(&mut content, &dir);
        let img = &content[1]["content"];
        assert!(img.get("data").is_none(), "no base64 left in the entry");
        assert_eq!((img["width"].as_u64(), img["height"].as_u64(), img["mimeType"].as_str()), (Some(5), Some(4), Some("image/png")));
        let (bytes, _) = load_image(&dir, img["image"].as_str().unwrap()).unwrap();
        assert_eq!(bytes, png(5, 4, false));
        assert!(content[2]["content"]["omitted"].as_str().unwrap().contains("couldn't be read"));
        assert_eq!(content[0]["content"]["text"], "Took a screenshot");
        // Already externalized: left alone.
        let before = content.clone();
        externalize_content(&mut content, &dir);
        assert_eq!(content, before);
        // Too large: left out, with why.
        let mut huge = json!({ "type": "image", "mimeType": "image/png", "data": "A".repeat(usize::try_from(MAX_AGENT_IMAGE).unwrap() / 3 * 4 + 8) });
        externalize_block(&mut huge, &dir);
        assert!(huge["omitted"].as_str().unwrap().contains("images over 20 MB aren't kept"));
    }

    #[test]
    fn image_dirs_sit_beside_the_transcript() {
        assert_eq!(image_dir(Some(Path::new("/h/.yaah/sessions/abc.json")), "abc"), PathBuf::from("/h/.yaah/sessions/abc.images"));
        let t = image_dir(None, "../x/y");
        assert!(t.starts_with(std::env::temp_dir()) && t.ends_with("___x_y"), "{}", t.display());
    }
}
