
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Instant,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct ConversionState {
    process: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressInfo {
    percent: f64,
    elapsed: f64,
    total: Option<f64>,
}

fn binary_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join(name));
        candidates.push(resource_dir.join(name));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(name),
    );

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("{name} est introuvable."))
}

fn get_duration(app: &AppHandle, input: &str) -> Option<f64> {
    let executable = binary_path(app, "ffprobe.exe").ok()?;

    let output = Command::new(executable)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
}

fn emit_progress(
    app: &AppHandle,
    percent: f64,
    started: Instant,
    duration: Option<f64>,
) {
    let _ = app.emit(
        "conversion-progress",
        ProgressInfo {
            percent: percent.clamp(0.0, 100.0),
            elapsed: started.elapsed().as_secs_f64(),
            total: duration,
        },
    );
}

fn run_ffmpeg(
    app: AppHandle,
    state: State<'_, ConversionState>,
    mut command: Command,
    duration: Option<f64>,
    success_message: &str,
    action_name: &str,
) -> Result<String, String> {
    {
        let process = state.process.lock().map_err(|e| e.to_string())?;

        if process.is_some() {
            return Err("Un traitement est déjà en cours.".into());
        }
    }

    state.cancelled.store(false, Ordering::SeqCst);

    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Impossible de lire la progression FFmpeg.")?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Impossible de lire les erreurs FFmpeg.")?;

    {
        let mut process = state.process.lock().map_err(|e| e.to_string())?;

        if process.is_some() {
            let _ = child.kill();
            return Err("Un autre traitement est déjà en cours.".into());
        }

        *process = Some(child);
    }

    let error_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut errors = String::new();
        let _ = reader.read_to_string(&mut errors);
        errors
    });

    let started = Instant::now();
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };

        if let Some(value) = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
        {
            if let Ok(time) = value.parse::<f64>() {
                let output_time = time / 1_000_000.0;

                let percent = duration
                    .filter(|total| *total > 0.0)
                    .map(|total| {
                        (output_time / total * 100.0).clamp(0.0, 99.5)
                    })
                    .unwrap_or(0.0);

                emit_progress(&app, percent, started, duration);
            }
        }
    }

    let mut child = {
        let mut process = state.process.lock().map_err(|e| e.to_string())?;
        process.take()
    };

    let result = match child.as_mut() {
        Some(process) => process.wait(),
        None => return Err("Le processus FFmpeg est introuvable.".into()),
    };

    let errors = error_reader.join().unwrap_or_default();

    if state.cancelled.load(Ordering::SeqCst) {
        emit_progress(&app, 0.0, started, duration);
        return Err(format!("{action_name} annulé."));
    }

    match result {
        Ok(status) if status.success() => {
            emit_progress(&app, 100.0, started, duration);
            Ok(success_message.to_string())
        }
        Ok(_) => {
            if errors.trim().is_empty() {
                Err(format!(
                    "FFmpeg a rencontré une erreur pendant {action_name}."
                ))
            } else {
                Err(errors)
            }
        }
        Err(error) => Err(format!("Erreur pendant {action_name} : {error}")),
    }
}

fn apply_video_resolution(
    command: &mut Command,
    resolution: Option<&str>,
) {
    let dimensions = match resolution.unwrap_or("original") {
        "1920x1080" => Some("1920:1080"),
        "1280x720" => Some("1280:720"),
        "854x480" => Some("854:480"),
        "640x360" => Some("640:360"),
        _ => None,
    };

    if let Some(dimensions) = dimensions {
        let filter = format!(
            "scale={dimensions}:force_original_aspect_ratio=decrease"
        );

        command.args(["-vf", &filter]);
    }
}

#[tauri::command]
fn check_ffmpeg(app: AppHandle) -> Result<String, String> {
    let executable = binary_path(&app, "ffmpeg.exe")?;

    let output = Command::new(executable)
        .arg("-version")
        .output()
        .map_err(|e| format!("Impossible de lancer FFmpeg : {e}"))?;

    if !output.status.success() {
        return Err("FFmpeg n'a pas démarré correctement.".into());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg détecté")
        .to_string())
}

#[tauri::command]
fn convert_media(
    app: AppHandle,
    state: State<'_, ConversionState>,
    input: String,
    output: String,
    quality: Option<String>,
    resolution: Option<String>,
    audio_bitrate: Option<String>,
    image_quality: Option<u8>,
) -> Result<String, String> {
    if !PathBuf::from(&input).is_file() {
        return Err("Le fichier source n'existe pas.".into());
    }

    let extension = PathBuf::from(&output)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !matches!(
        extension.as_str(),
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a"
            | "mp4" | "mkv" | "mov" | "avi" | "webm"
            | "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tiff"
    ) {
        return Err(format!(
            "Le format .{extension} n'est pas pris en charge par FFmpeg."
        ));
    }

    let executable = binary_path(&app, "ffmpeg.exe")?;
    let duration = get_duration(&app, &input);

    let mut command = Command::new(executable);
    command.args(["-y", "-hide_banner", "-i", &input]);

    match extension.as_str() {
        "mp3" => {
            command.args(["-vn", "-c:a", "libmp3lame"]);
            command.args([
                "-b:a",
                audio_bitrate.as_deref().unwrap_or("192k"),
            ]);
        }
        "wav" => {
            command.args(["-vn", "-c:a", "pcm_s16le"]);
        }
        "flac" => {
            command.args(["-vn", "-c:a", "flac"]);
        }
        "aac" | "m4a" => {
            command.args(["-vn", "-c:a", "aac"]);
            command.args([
                "-b:a",
                audio_bitrate.as_deref().unwrap_or("192k"),
            ]);
        }
        "ogg" => {
            command.args(["-vn", "-c:a", "libvorbis"]);
            command.args([
                "-b:a",
                audio_bitrate.as_deref().unwrap_or("192k"),
            ]);
        }
        _ => {}
    }

    if matches!(
        extension.as_str(),
        "mp4" | "mkv" | "mov" | "avi" | "webm"
    ) {
        let selected_quality = quality.as_deref().unwrap_or("balanced");

        let crf = match selected_quality {
            "high" => "18",
            "small" => "28",
            _ => "23",
        };

        match extension.as_str() {
            "webm" => {
                command.args([
                    "-c:v", "libvpx-vp9",
                    "-crf", crf,
                    "-b:v", "0",
                    "-c:a", "libopus",
                ]);
            }
            "avi" => {
                command.args([
                    "-c:v", "mpeg4",
                    "-q:v", "5",
                    "-c:a", "libmp3lame",
                ]);
            }
            _ => {
                command.args([
                    "-c:v", "libx264",
                    "-preset", "medium",
                    "-crf", crf,
                    "-c:a", "aac",
                    "-b:a", "192k",
                ]);
            }
        }

        apply_video_resolution(&mut command, resolution.as_deref());
    }

    match extension.as_str() {
        "jpg" | "jpeg" => {
            let quality = image_quality.unwrap_or(85).clamp(1, 100);
            let qscale = 31 - ((quality as u16 * 29) / 100);

            command.args(["-q:v", &qscale.to_string()]);
        }
        "webp" => {
            let quality = image_quality.unwrap_or(85).clamp(1, 100);

            command.args([
                "-c:v", "libwebp",
                "-quality", &quality.to_string(),
            ]);
        }
        "png" => {
            let quality = image_quality.unwrap_or(85).clamp(1, 100);
            let compression = ((100 - quality) * 9 / 100).to_string();

            command.args([
                "-c:v", "png",
                "-compression_level", &compression,
            ]);
        }
        _ => {}
    }

    command.args([
        "-progress", "pipe:1",
        "-nostats",
        &output,
    ]);

    run_ffmpeg(
        app,
        state,
        command,
        duration,
        "Conversion terminée avec succès.",
        "la conversion",
    )
}

#[tauri::command]
fn compress_media(
    app: AppHandle,
    state: State<'_, ConversionState>,
    input: String,
    output: String,
    compression_mode: String,
    target_size_mb: Option<u32>,
    compression_quality: Option<String>,
) -> Result<String, String> {
    if !PathBuf::from(&input).is_file() {
        return Err("Le fichier source n'existe pas.".into());
    }

    if !matches!(compression_mode.as_str(), "size" | "quality") {
        return Err("Méthode de compression invalide.".into());
    }

    if compression_mode == "size" {
        let size = target_size_mb.ok_or("Indique un poids cible.")?;

        if size == 0 || size > 10000 {
            return Err(
                "Le poids cible doit être compris entre 1 et 10000 Mo.".into()
            );
        }
    }

    let quality = compression_quality
        .as_deref()
        .unwrap_or("medium");

    if !matches!(quality, "high" | "medium" | "low") {
        return Err("Niveau de compression invalide.".into());
    }

    let extension = PathBuf::from(&output)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    let executable = binary_path(&app, "ffmpeg.exe")?;
    let duration = get_duration(&app, &input);

    let mut command = Command::new(executable);
    command.args(["-y", "-hide_banner", "-i", &input]);

    let is_video = matches!(
        extension.as_str(),
        "mp4" | "mkv" | "mov" | "avi" | "webm"
    );

    let is_audio = matches!(
        extension.as_str(),
        "mp3" | "aac" | "m4a" | "ogg"
    );

    let is_image = matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "webp" | "png"
    );

    if is_video {
        if compression_mode == "size" {
            let duration = duration
                .filter(|value| *value > 0.0)
                .ok_or("Impossible de déterminer la durée de cette vidéo.")?;

            let size = target_size_mb.unwrap() as f64;

            let total_kbps =
                size * 1024.0 * 1024.0 * 8.0 * 0.95
                    / duration
                    / 1000.0;

            let audio_kbps = if total_kbps > 160.0 {
                128.0
            } else {
                64.0
            };

            let video_kbps = total_kbps - audio_kbps;

            if video_kbps < 50.0 {
                return Err(
                    "Le poids cible est trop faible pour cette vidéo. Augmente la taille cible.".into()
                );
            }

            let video_bitrate = format!("{:.0}k", video_kbps);
            let audio_bitrate = format!("{:.0}k", audio_kbps);
            let buffer_size = format!("{:.0}k", video_kbps * 2.0);

            match extension.as_str() {
                "webm" => {
                    command.args([
                        "-c:v", "libvpx-vp9",
                        "-b:v", &video_bitrate,
                        "-maxrate", &video_bitrate,
                        "-bufsize", &buffer_size,
                        "-c:a", "libopus",
                        "-b:a", &audio_bitrate,
                    ]);
                }
                "avi" => {
                    command.args([
                        "-c:v", "mpeg4",
                        "-b:v", &video_bitrate,
                        "-c:a", "libmp3lame",
                        "-b:a", &audio_bitrate,
                    ]);
                }
                _ => {
                    command.args([
                        "-c:v", "libx264",
                        "-preset", "medium",
                        "-b:v", &video_bitrate,
                        "-maxrate", &video_bitrate,
                        "-bufsize", &buffer_size,
                        "-c:a", "aac",
                        "-b:a", &audio_bitrate,
                    ]);
                }
            }
        } else {
            let (crf, preset, webm_crf, avi_q) = match quality {
                "high" => ("20", "slow", "24", "3"),
                "low" => ("32", "fast", "40", "8"),
                _ => ("26", "medium", "32", "5"),
            };

            match extension.as_str() {
                "webm" => {
                    command.args([
                        "-c:v", "libvpx-vp9",
                        "-crf", webm_crf,
                        "-b:v", "0",
                        "-c:a", "libopus",
                        "-b:a", "128k",
                    ]);
                }
                "avi" => {
                    command.args([
                        "-c:v", "mpeg4",
                        "-q:v", avi_q,
                        "-c:a", "libmp3lame",
                        "-b:a", "128k",
                    ]);
                }
                _ => {
                    command.args([
                        "-c:v", "libx264",
                        "-preset", preset,
                        "-crf", crf,
                        "-c:a", "aac",
                        "-b:a", "128k",
                    ]);
                }
            }
        }
    } else if is_audio {
        let bitrate = if compression_mode == "size" {
            let duration = duration
                .filter(|value| *value > 0.0)
                .ok_or("Impossible de déterminer la durée de ce fichier audio.")?;

            let size = target_size_mb.unwrap() as f64;

            let kbps =
                size * 1024.0 * 1024.0 * 8.0 * 0.95
                    / duration
                    / 1000.0;

            format!("{:.0}k", kbps.clamp(32.0, 320.0))
        } else {
            match quality {
                "high" => "192k".to_string(),
                "low" => "96k".to_string(),
                _ => "128k".to_string(),
            }
        };

        match extension.as_str() {
            "mp3" => {
                command.args([
                    "-vn",
                    "-c:a", "libmp3lame",
                    "-b:a", &bitrate,
                ]);
            }
            "ogg" => {
                command.args([
                    "-vn",
                    "-c:a", "libvorbis",
                    "-b:a", &bitrate,
                ]);
            }
            _ => {
                command.args([
                    "-vn",
                    "-c:a", "aac",
                    "-b:a", &bitrate,
                ]);
            }
        }
    } else if is_image {
        if compression_mode == "size" {
            return Err(
                "Pour les images, choisis le mode « Qualité souhaitée ». Le poids final dépend du contenu de l'image.".into()
            );
        }

        let image_quality: u32 = match quality {
            "high" => 90,
            "low" => 50,
            _ => 75,
        };

        match extension.as_str() {
            "jpg" | "jpeg" => {
                let qscale = 31 - ((image_quality * 29) / 100);
                command.args(["-q:v", &qscale.to_string()]);
            }
            "webp" => {
                command.args([
                    "-c:v", "libwebp",
                    "-quality", &image_quality.to_string(),
                ]);
            }
            "png" => {
                let compression = match quality {
                    "high" => "1",
                    "low" => "9",
                    _ => "6",
                };

                command.args([
                    "-c:v", "png",
                    "-compression_level", compression,
                ]);
            }
            _ => {}
        }
    } else if matches!(extension.as_str(), "wav" | "flac") {
        return Err(
            "WAV et FLAC sont des formats audio sans perte. Choisis MP3, AAC ou OGG pour réduire réellement le poids.".into()
        );
    } else {
        return Err(format!(
            "La compression du format .{extension} n'est pas prise en charge."
        ));
    }

    command.args([
        "-progress", "pipe:1",
        "-nostats",
        &output,
    ]);

    let message = if is_image {
        "Compression de l'image terminée. Le poids final dépend du contenu."
    } else if compression_mode == "size" {
        "Compression terminée. Le poids final peut légèrement varier de la cible."
    } else {
        "Compression terminée avec la qualité choisie."
    };

    run_ffmpeg(
        app,
        state,
        command,
        duration,
        message,
        "la compression",
    )
}

// -----------------------------------------------------------------------------
// CONVERSION DE DOCUMENTS
// -----------------------------------------------------------------------------

fn find_libreoffice() -> Result<PathBuf, String> {
    let candidates = [
        PathBuf::from(r"C:\Program Files\LibreOffice\program\soffice.exe"),
        PathBuf::from(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
    ];

    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Some(path_variable) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path_variable) {
            let candidate = directory.join("soffice.exe");

            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(
        "LibreOffice est introuvable. Installe LibreOffice pour convertir les documents bureautiques.".into()
    )
}

fn normalize_document_extension(extension: &str) -> &str {
    if extension == "htm" {
        "html"
    } else {
        extension
    }
}

fn read_text_document(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| {
        format!(
            "Impossible de lire le document texte. Vérifie son encodage UTF-8 : {error}"
        )
    })
}

fn markdown_to_plain_text(markdown: &str) -> String {
    let mut result = String::new();

    for line in markdown.lines() {
        let mut value = line.trim().to_string();

        while value.starts_with('#') {
            value.remove(0);
        }

        value = value
            .replace("**", "")
            .replace("__", "")
            .replace("~~", "")
            .replace('`', "");

        result.push_str(value.trim());
        result.push('\n');
    }

    result
}

fn html_to_plain_text(html: &str) -> String {
    let mut result = String::new();
    let mut inside_tag = false;

    for character in html.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => {
                inside_tag = false;
                result.push(' ');
            }
            _ if !inside_tag => result.push(character),
            _ => {}
        }
    }

    result
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
}

fn convert_simple_text_document(
    input: &Path,
    output: &Path,
    source_extension: &str,
    target_extension: &str,
) -> Result<String, String> {
    let source = read_text_document(input)?;

    let converted = match (source_extension, target_extension) {
        ("md", "txt") => markdown_to_plain_text(&source),
        ("html", "txt") => html_to_plain_text(&source),
        ("htm", "txt") => html_to_plain_text(&source),
        ("xml", "txt") => html_to_plain_text(&source),
        ("csv", "txt") => source,
        ("txt", "md") => source,
        ("txt", "csv") => source,
        ("md", "html") => {
            let escaped = source
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");

            format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><pre>{escaped}</pre></body></html>"
            )
        }
        _ => {
            return Err(
                "Cette conversion de document texte n'est pas prise en charge.".into()
            );
        }
    };

    fs::write(output, converted)
        .map_err(|error| format!("Impossible d'écrire le document converti : {error}"))?;

    Ok("Conversion du document terminée.".into())
}

#[tauri::command]
fn process_document(
    input: String,
    output: String,
) -> Result<String, String> {
    let input_path = PathBuf::from(&input);
    let output_path = PathBuf::from(&output);

    if !input_path.is_file() {
        return Err("Le fichier source n'existe pas.".into());
    }

    let source_extension = input_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    let target_extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    let allowed = ["odt", "txt", "html", "htm", "rtf", "md", "csv", "xml"];

    if !allowed.contains(&source_extension.as_str()) {
        return Err(format!(
            "Le document source .{source_extension} n'est pas pris en charge."
        ));
    }

    if !allowed.contains(&target_extension.as_str()) {
        return Err(format!(
            "Le format de sortie .{target_extension} n'est pas pris en charge."
        ));
    }

    if input_path == output_path {
        return Err(
            "Le fichier de destination doit être différent du fichier source.".into()
        );
    }

    let output_directory = output_path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or("Le dossier de destination n'existe pas.")?;

    let source_format = normalize_document_extension(&source_extension);
    let target_format = normalize_document_extension(&target_extension);

    if source_format == target_format {
        return Err("Choisis un format de sortie différent du format source.".into());
    }

    // Conversions simples de fichiers texte.
    if matches!(
        (source_format, target_format),
        ("md", "txt")
            | ("txt", "md")
            | ("html", "txt")
            | ("xml", "txt")
            | ("csv", "txt")
            | ("txt", "csv")
            | ("md", "html")
    ) {
        return convert_simple_text_document(
            &input_path,
            &output_path,
            source_format,
            target_format,
        );
    }

    // Les autres conversions sont déléguées à LibreOffice.
    let soffice = find_libreoffice()?;

    let filter = match target_format {
        "odt" => "odt",
        "txt" => "txt:Text",
        "html" => "html:XHTML Writer File",
        "rtf" => "rtf:Rich Text Format",
        "csv" => "csv:Text - txt - csv (StarCalc)",
        "xml" | "md" => {
            return Err(format!(
                "La conversion vers .{target_format} n'est pas disponible avec LibreOffice dans cette application."
            ));
        }
        _ => return Err("Format de sortie non pris en charge.".into()),
    };

    let source_stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Nom de fichier source invalide.")?;

    let generated_path = output_directory.join(format!(
        "{}.{}",
        source_stem,
        target_format
    ));

    if generated_path.exists() {
        fs::remove_file(&generated_path)
            .map_err(|error| format!("Impossible de remplacer l'ancien fichier : {error}"))?;
    }

    let result = Command::new(soffice)
        .arg("--headless")
        .arg("--convert-to")
        .arg(filter)
        .arg("--outdir")
        .arg(output_directory)
        .arg(&input_path)
        .output()
        .map_err(|error| format!("Impossible de lancer LibreOffice : {error}"))?;

    if !result.status.success() {
        let details = String::from_utf8_lossy(&result.stderr)
            .trim()
            .to_string();

        return Err(if details.is_empty() {
            "LibreOffice n'a pas réussi à convertir le document.".into()
        } else {
            details
        });
    }

    if !generated_path.is_file() {
        let details = String::from_utf8_lossy(&result.stderr)
            .trim()
            .to_string();

        return Err(if details.is_empty() {
            "LibreOffice n'a pas créé le fichier de destination.".into()
        } else {
            details
        });
    }

    if generated_path != output_path {
        if output_path.exists() {
            fs::remove_file(&output_path)
                .map_err(|error| format!("Impossible de remplacer la destination : {error}"))?;
        }

        fs::rename(&generated_path, &output_path)
            .map_err(|error| format!("Impossible de déplacer le document converti : {error}"))?;
    }

    Ok("Conversion du document terminée avec LibreOffice.".into())
}

#[tauri::command]
fn cancel_conversion(
    state: State<'_, ConversionState>,
) -> Result<(), String> {
    state.cancelled.store(true, Ordering::SeqCst);

    let mut process = state.process.lock().map_err(|e| e.to_string())?;

    if let Some(child) = process.as_mut() {
        child
            .kill()
            .map_err(|e| format!("Impossible d'annuler le traitement : {e}"))?;
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(ConversionState {
            process: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            convert_media,
            compress_media,
            process_document,
            cancel_conversion
        ])
        .run(tauri::generate_context!())
        .expect("Erreur au démarrage de MediaConverter");
}
