
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";

import {
  AudioLines,
  Video,
  Image as ImageIcon,
  FileText,
  Settings,
  History,
  Library,
  Plus,
  Trash2,
  Moon,
  Sun,
  Sparkles,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  WandSparkles,
  FileVideo,
  Music2,
  X,
  RefreshCw,
  Ban,
  SlidersHorizontal,
  Clock3,
  ArrowLeft,
  RefreshCcw,
} from "lucide-react";

type Category = "Audio" | "Vidéo" | "Image" | "Document";
type FileStatus = "waiting" | "processing" | "done" | "error";
type Theme = "dark" | "light";
type Action = "conversion" | "compression";
type CompressionMode = "size" | "quality";
type CompressionQuality = "high" | "medium" | "low";

interface MediaFile {
  id: string;
  path: string;
  name: string;
  category: Category;
  format: string;
  status: FileStatus;
  error?: string;
}

interface HistoryEntry {
  id: string;
  source: string;
  destination: string;
  format: string;
  date: string;
  status: "done" | "error";
  message?: string;
}

interface ProgressInfo {
  percent: number;
  elapsed: number;
  total: number | null;
}

interface Preferences {
  theme: Theme;
  outputFolder: string;
  resolution: string;
}

const FORMATS: Record<Category, string[]> = {
  Audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a"],
  Vidéo: ["mp4", "mkv", "mov", "avi", "webm", "mp3"],
  Image: ["png", "jpg", "webp", "bmp", "tiff"],
  Document: [],
};

const CATEGORY_ICONS = {
  Audio: AudioLines,
  Vidéo: Video,
  Image: ImageIcon,
  Document: FileText,
};

const DOCUMENT_FORMATS: Record<string, string[]> = {
  odt: ["txt", "html", "rtf"],
  txt: ["odt", "html", "rtf", "md", "csv"],
  html: ["odt", "txt", "rtf"],
  htm: ["odt", "txt", "rtf"],
  rtf: ["odt", "txt", "html"],
  md: ["txt", "html"],
  csv: ["txt"],
  xml: ["txt"],
};

const DEFAULT_PREFERENCES: Preferences = {
  theme: "dark",
  outputFolder: "",
  resolution: "original",
};

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);

    if (!value) return fallback;

    const parsed: unknown = JSON.parse(value);

    if (Array.isArray(fallback)) {
      if (Array.isArray(parsed)) {
        return parsed as T;
      }

      if (parsed && typeof parsed === "object") {
        const recovered = Object.keys(parsed)
          .filter((item) => /^\d+$/.test(item))
          .sort((a, b) => Number(a) - Number(b))
          .map(
            (item) =>
              (parsed as Record<string, unknown>)[item]
          );

        return recovered as T;
      }

      return fallback;
    }

    if (
      fallback &&
      typeof fallback === "object" &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return {
        ...fallback,
        ...parsed,
      } as T;
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

function detectCategory(filename: string): Category {
  const extension = getExtension(filename);

  if (
    ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]
      .includes(extension)
  ) {
    return "Audio";
  }

  if (
    ["mp4", "mkv", "mov", "avi", "webm", "wmv", "mpeg"]
      .includes(extension)
  ) {
    return "Vidéo";
  }

  if (
    ["png", "jpg", "jpeg", "webp", "bmp", "tiff", "gif"]
      .includes(extension)
  ) {
    return "Image";
  }

  return "Document";
}

function getAvailableFormats(file: MediaFile): string[] {
  if (file.category !== "Document") {
    return FORMATS[file.category];
  }

  return DOCUMENT_FORMATS[getExtension(file.name)] || [];
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function getOutputName(filename: string, format: string): string {
  return `${filename.replace(/\.[^/.]+$/, "")}.${format}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";

  const value = Math.ceil(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;

  if (hours > 0) {
    return `${hours} h ${minutes.toString().padStart(2, "0")} min`;
  }

  if (minutes > 0) {
    return `${minutes} min ${secs.toString().padStart(2, "0")} s`;
  }

  return `${secs} s`;
}

function App() {
  const [files, setFiles] = useState<MediaFile[]>([]);

  const [engineStatus, setEngineStatus] =
    useState<"checking" | "ready" | "error">("checking");

  const [engineMessage, setEngineMessage] =
    useState("Vérification de FFmpeg...");

  const [isConverting, setIsConverting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const [currentFile, setCurrentFile] = useState("");
  const [currentAction, setCurrentAction] = useState<Action>("conversion");

  const [activeMode, setActiveMode] = useState<Action | null>(null);

  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("size");

  const [targetSizeMB, setTargetSizeMB] = useState(25);

  const [compressionQuality, setCompressionQuality] =
    useState<CompressionQuality>("medium");

  const [progressInfo, setProgressInfo] = useState<ProgressInfo>({
    percent: 0,
    elapsed: 0,
    total: null,
  });

  const [dragging, setDragging] = useState(false);
  const [notification, setNotification] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [history, setHistory] = useState<HistoryEntry[]>(() =>
    readStorage<HistoryEntry[]>("mediaconverter-history", [])
  );

  const [preferences, setPreferences] = useState<Preferences>(() =>
    readStorage<Preferences>(
      "mediaconverter-preferences",
      DEFAULT_PREFERENCES
    )
  );

  const cancelRequested = useRef(false);
  const notificationTimer = useRef<number | undefined>(undefined);

  const supportedPendingCount = files.filter(
    (file) =>
      (file.status === "waiting" || file.status === "error") &&
      getAvailableFormats(file).length > 0
  ).length;

  const progress = progressInfo.percent;

  const estimatedRemaining =
    progress > 0 && progress < 100
      ? (progressInfo.elapsed * (100 - progress)) / progress
      : null;

  const notify = useCallback((message: string) => {
    setNotification(message);

    if (notificationTimer.current) {
      window.clearTimeout(notificationTimer.current);
    }

    notificationTimer.current = window.setTimeout(
      () => setNotification(""),
      4000
    );
  }, []);

  // Sauvegarde de l'historique.
  useEffect(() => {
    try {
      localStorage.setItem(
        "mediaconverter-history",
        JSON.stringify(history)
      );
    } catch (error) {
      console.error("Impossible de sauvegarder l'historique :", error);
    }
  }, [history]);

  // Sauvegarde des préférences.
  useEffect(() => {
    try {
      localStorage.setItem(
        "mediaconverter-preferences",
        JSON.stringify(preferences)
      );
    } catch (error) {
      console.error("Impossible de sauvegarder les préférences :", error);
    }

    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences]);

  useEffect(() => {
    return () => {
      if (notificationTimer.current) {
        window.clearTimeout(notificationTimer.current);
      }
    };
  }, []);

  const addPaths = useCallback((paths: string[]) => {
    setFiles((previous) => {
      const existing = new Set(previous.map((file) => file.path));
      const added: MediaFile[] = [];

      for (const path of paths) {
        if (existing.has(path)) continue;

        existing.add(path);

        const name = getFileName(path);
        const category = detectCategory(name);

        const newFile: MediaFile = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          path,
          name,
          category,
          format: "",
          status: "waiting",
        };

        const formats = getAvailableFormats(newFile);
        newFile.format = formats[0] || "";

        added.push(newFile);
      }

      if (added.length > 0) {
        window.setTimeout(
          () => notify(`${added.length} fichier(s) ajouté(s).`),
          0
        );
      }

      return [...previous, ...added];
    });
  }, [notify]);

  // Vérification de FFmpeg.
  useEffect(() => {
    let mounted = true;

    invoke<string>("check_ffmpeg")
      .then((result) => {
        if (mounted) {
          setEngineStatus("ready");
          setEngineMessage(result);
        }
      })
      .catch((error) => {
        if (mounted) {
          setEngineStatus("error");
          setEngineMessage(String(error));
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Écoute de la progression FFmpeg.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<ProgressInfo>("conversion-progress", (event) => {
      setProgressInfo({
        percent: Math.max(
          0,
          Math.min(100, event.payload.percent || 0)
        ),
        elapsed: event.payload.elapsed || 0,
        total: event.payload.total ?? null,
      });
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Glisser-déposer des fichiers.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (
          event.payload.type === "enter" ||
          event.payload.type === "over"
        ) {
          setDragging(true);
        }

        if (event.payload.type === "leave") {
          setDragging(false);
        }

        if (event.payload.type === "drop") {
          setDragging(false);
          addPaths(event.payload.paths);
        }
      })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch((error) => {
        console.error("Glisser-déposer indisponible :", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths]);

  async function addFiles() {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: "Choisir des fichiers",
      });

      if (!selected) return;

      addPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (error) {
      notify(`Erreur : ${String(error)}`);
    }
  }

  function updatePreference<K extends keyof Preferences>(
    key: K,
    value: Preferences[K]
  ) {
    setPreferences((previous) => ({
      ...previous,
      [key]: value,
    }));
  }

  async function chooseOutputFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choisir le dossier de destination",
      });

      if (typeof selected === "string") {
        updatePreference("outputFolder", selected);
        notify("Dossier de sortie enregistré.");
      }
    } catch (error) {
      notify(`Impossible de choisir le dossier : ${String(error)}`);
    }
  }

  async function selectOutputPath(
    file: MediaFile,
    compressed: boolean
  ): Promise<string | null | false> {
    const extension = compressed
      ? getExtension(file.name)
      : file.format;

    if (!extension) {
      notify("Aucun format de sortie sélectionné.");
      return false;
    }

    const outputName = compressed
      ? `${file.name.replace(/\.[^/.]+$/, "")}_compressed.${extension}`
      : getOutputName(file.name, extension);

    const defaultPath = preferences.outputFolder
      ? `${preferences.outputFolder.replace(/[\\/]+$/, "")}\\${outputName}`
      : outputName;

    try {
      return await save({
        title: compressed
          ? "Enregistrer le fichier compressé"
          : "Enregistrer le fichier converti",
        defaultPath,
        filters: [
          {
            name: `${extension.toUpperCase()} files`,
            extensions: [extension],
          },
        ],
      });
    } catch (error) {
      notify(`Erreur de destination : ${String(error)}`);
      return false;
    }
  }

  async function processFile(
    file: MediaFile,
    action: Action
  ): Promise<boolean> {
    if (cancelRequested.current) return false;

    const availableFormats = getAvailableFormats(file);

    if (availableFormats.length === 0) {
      setFiles((previous) =>
        previous.map((item) =>
          item.id === file.id
            ? {
                ...item,
                status: "error",
                error: "Ce format de fichier n'est pas pris en charge.",
              }
            : item
        )
      );

      return true;
    }

    if (
      action === "conversion" &&
      !availableFormats.includes(file.format)
    ) {
      notify("Choisis un format de sortie compatible.");
      return true;
    }

    if (
      action === "compression" &&
      file.category === "Document"
    ) {
      setFiles((previous) =>
        previous.map((item) =>
          item.id === file.id
            ? {
                ...item,
                status: "error",
                error: "La compression des documents n'est pas disponible.",
              }
            : item
        )
      );

      return true;
    }

    if (
      action === "compression" &&
      compressionMode === "size" &&
      file.category === "Image"
    ) {
      setFiles((previous) =>
        previous.map((item) =>
          item.id === file.id
            ? {
                ...item,
                status: "error",
                error: "Pour les images, utilise le mode « Qualité souhaitée ».",
              }
            : item
        )
      );

      return true;
    }

    if (
      action === "compression" &&
      ["wav", "flac"].includes(getExtension(file.name))
    ) {
      setFiles((previous) =>
        previous.map((item) =>
          item.id === file.id
            ? {
                ...item,
                status: "error",
                error: "Choisis MP3, AAC ou OGG pour réduire le poids de ce fichier audio.",
              }
            : item
        )
      );

      return true;
    }

    const outputPath = await selectOutputPath(
      file,
      action === "compression"
    );

    if (outputPath === false) return false;
    if (!outputPath) return true;
    if (cancelRequested.current) return false;

    setCurrentFile(file.name);

    setProgressInfo({
      percent: 0,
      elapsed: 0,
      total: null,
    });

    setFiles((previous) =>
      previous.map((item) =>
        item.id === file.id
          ? {
              ...item,
              status: "processing",
              error: undefined,
            }
          : item
      )
    );

    try {
      if (file.category === "Document") {
        await invoke<string>("process_document", {
          input: file.path,
          output: outputPath,
        });
      } else if (action === "conversion") {
        await invoke<string>("convert_media", {
          input: file.path,
          output: outputPath,
          quality: "balanced",
          resolution: preferences.resolution,
          audioBitrate: "192k",
          imageQuality: 85,
        });
      } else {
        await invoke<string>("compress_media", {
          input: file.path,
          output: outputPath,
          compressionMode,
          targetSizeMb:
            compressionMode === "size" ? targetSizeMB : null,
          compressionQuality:
            compressionMode === "quality"
              ? compressionQuality
              : null,
        });
      }

      const historyFormat =
        file.category === "Document"
          ? `DOCUMENT · ${file.format.toUpperCase()}`
          : action === "compression"
            ? compressionMode === "size"
              ? `COMPRESSÉ · CIBLE ${targetSizeMB} Mo`
              : `COMPRESSÉ · QUALITÉ ${compressionQuality.toUpperCase()}`
            : file.format.toUpperCase();

      setHistory((previous) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          source: file.name,
          destination: outputPath,
          format: historyFormat,
          date: new Date().toLocaleString("fr-FR"),
          status: "done",
        },
        ...previous,
      ]);

      setFiles((previous) =>
        previous.map((item) =>
          item.id === file.id
            ? {
                ...item,
                status: "done",
                error: undefined,
              }
            : item
        )
      );

      setProgressInfo((previous) => ({
        ...previous,
        percent: 100,
      }));

      return true;
    } catch (error) {
      const message = String(error);

      const wasCancelled =
        cancelRequested.current ||
        message.toLowerCase().includes("annul");

      if (!wasCancelled) {
        setHistory((previous) => [
          {
            id: `${Date.now()}-${Math.random()}`,
            source: file.name,
            destination: outputPath,
            format:
              file.category === "Document"
                ? `DOCUMENT · ${file.format.toUpperCase()}`
                : action === "compression"
                  ? "COMPRESSION"
                  : file.format.toUpperCase(),
            date: new Date().toLocaleString("fr-FR"),
            status: "error",
            message,
          },
          ...previous,
        ]);
      }

      setFiles((previous) =>
        previous.map((item) =>
          item.id === file.id
            ? {
                ...item,
                status: wasCancelled ? "waiting" : "error",
                error: wasCancelled ? undefined : message,
              }
            : item
        )
      );

      return !wasCancelled;
    }
  }

  async function startProcessing(action: Action) {
    if (isConverting || engineStatus !== "ready") return;

    const pending = files.filter(
      (file) =>
        file.status === "waiting" ||
        file.status === "error"
    );

    if (pending.length === 0) {
      notify(
        action === "compression"
          ? "Aucun fichier en attente de compression."
          : "Aucun fichier en attente de conversion."
      );

      return;
    }

    const supported = pending.filter((file) => {
      if (action === "compression") {
        return (
          file.category !== "Document" &&
          getAvailableFormats(file).length > 0
        );
      }

      return getAvailableFormats(file).length > 0;
    });

    if (supported.length === 0) {
      notify(
        action === "compression"
          ? "Aucun fichier multimédia compatible avec la compression."
          : "Aucun fichier compatible avec la conversion."
      );

      return;
    }

    if (
      action === "compression" &&
      compressionMode === "size" &&
      (
        !Number.isFinite(targetSizeMB) ||
        targetSizeMB < 1 ||
        targetSizeMB > 10000
      )
    ) {
      notify("Indique un poids cible compris entre 1 et 10000 Mo.");
      return;
    }

    cancelRequested.current = false;

    setIsCancelling(false);
    setIsConverting(true);
    setCurrentAction(action);

    setProgressInfo({
      percent: 0,
      elapsed: 0,
      total: null,
    });

    try {
      for (const file of supported) {
        if (cancelRequested.current) break;

        const shouldContinue = await processFile(file, action);

        if (!shouldContinue) break;
      }
    } finally {
      setIsConverting(false);
      setIsCancelling(false);
      setCurrentFile("");

      setProgressInfo({
        percent: 0,
        elapsed: 0,
        total: null,
      });

      notify(
        cancelRequested.current
          ? "Traitement interrompu."
          : action === "compression"
            ? "Compression terminée."
            : "Conversion terminée."
      );
    }
  }

  async function cancelConversion() {
    if (!isConverting || isCancelling) return;

    cancelRequested.current = true;
    setIsCancelling(true);

    try {
      await invoke("cancel_conversion");
    } catch (error) {
      console.warn("Annulation du traitement :", error);
    }
  }

  function changeFormat(id: string, format: string) {
    setFiles((previous) =>
      previous.map((file) =>
        file.id === id
          ? {
              ...file,
              format,
              status: "waiting",
              error: undefined,
            }
          : file
      )
    );
  }

  function removeFile(id: string) {
    if (!isConverting) {
      setFiles((previous) =>
        previous.filter((file) => file.id !== id)
      );
    }
  }

  function clearQueue() {
    if (!isConverting) {
      setFiles([]);
    }
  }

  function resetFile(file: MediaFile) {
    setFiles((previous) =>
      previous.map((item) =>
        item.id === file.id
          ? {
              ...item,
              status: "waiting",
              error: undefined,
            }
          : item
      )
    );
  }

  async function retryEngineCheck() {
    setEngineStatus("checking");

    try {
      const result = await invoke<string>("check_ffmpeg");

      setEngineStatus("ready");
      setEngineMessage(result);

      notify("FFmpeg est opérationnel.");
    } catch (error) {
      setEngineStatus("error");
      setEngineMessage(String(error));

      notify(`FFmpeg indisponible : ${String(error)}`);
    }
  }

  function renderStatus(file: MediaFile) {
    if (file.status === "processing") {
      return (
        <span className="file-status processing">
          <Loader2 size={14} className="spin" />
          {currentAction === "compression" ? "Compression" : "Conversion"}
        </span>
      );
    }

    if (file.status === "done") {
      return (
        <span className="file-status done">
          <CheckCircle2 size={14} /> Terminé
        </span>
      );
    }

    if (file.status === "error") {
      return (
        <span className="file-status error" title={file.error}>
          <AlertCircle size={14} /> Erreur
        </span>
      );
    }

    return (
      <span className="file-status waiting">
        En attente
      </span>
    );
  }

  return (
    <div className={`app-shell ${preferences.theme === "light" ? "theme-light" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <WandSparkles size={25} />
          </div>

          <div>
            <h1>MediaConverter</h1>
            <span>THE ULTIMATE EDITION</span>
          </div>
        </div>

        <div className="sidebar-section">
          <span className="sidebar-label"></span>

          <button className="nav-item active">
            <Library size={18} />
            <span>Convertisseur</span>
          </button>

          <button
            className={`nav-item ${showHistory ? "active" : ""}`}
            onClick={() => setShowHistory(true)}
          >
            <History size={18} />
            <span>Historique</span>
          </button>

          <button
            className="nav-item"
            onClick={() => setShowSettings(true)}
          >
            <Settings size={18} />
            <span>Paramètres</span>
          </button>
        </div>

        <div className="sidebar-bottom">
          <div className="engine-card">
            <div className="engine-heading">
              <span className={`engine-dot ${engineStatus}`} />
              <strong>Moteur FFmpeg</strong>
            </div>

            <p>
              {engineStatus === "ready"
                ? "Moteur opérationnel"
                : engineStatus === "checking"
                  ? "Initialisation..."
                  : "Moteur indisponible"}
            </p>

            {engineStatus === "error" && (
              <button
                className="engine-retry"
                onClick={retryEngineCheck}
              >
                <RefreshCw size={13} /> Réessayer
              </button>
            )}
          </div>

          <div className="sidebar-footer">
            {preferences.theme === "dark" ? (
              <Moon size={15} />
            ) : (
              <Sun size={15} />
            )}

            <span>
              {preferences.theme === "dark"
                ? "Dark Fantasy Edition"
                : "Light Edition"}
            </span>

            <span className="version">v3.1</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="breadcrumb">COMPRESSEUR /</span>
            <span className="breadcrumb-current"> CONVERTISSEUR</span>
          </div>

          <div className="topbar-right">
            <span className="local-badge">
              <span className="engine-dot ready" />
              Traitement local
            </span>

            <button
              className="icon-button"
              title="Paramètres"
              onClick={() => setShowSettings(true)}
            >
              <Settings size={19} />
            </button>
          </div>
        </header>

        <div className="page-content">
          <section className="welcome-section">
            <div>
              <div className="eyebrow">
                <Sparkles size={14} />
                <span>VOTRE ATELIER MULTIMÉDIA</span>
              </div>

              <h2>
                Transformez vos fichiers
                <br />
                <span>sans limites.</span>
              </h2>

              <p>
                Convertissez et compressez vos médias simplement,
                rapidement et en toute confidentialité.
                Vos fichiers restent sur votre ordinateur.
              </p>
            </div>

            <div className="welcome-decoration">
              <div className="decoration-orbit orbit-one" />
              <div className="decoration-orbit orbit-two" />

              <div className="decoration-icon">
                <WandSparkles size={55} />
              </div>
            </div>
          </section>

          <section className="converter-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">ATELIER MULTIMÉDIA</span>
                <h3>Votre file d'attente</h3>
              </div>

              <button
                className="secondary-button"
                onClick={addFiles}
                disabled={isConverting}
              >
                <Plus size={17} /> Ajouter des fichiers
              </button>
            </div>

            <div
              className={`drop-zone ${dragging ? "dragging" : ""}`}
              onClick={addFiles}
            >
              <div className="drop-icon">
                <FolderOpen size={29} />
              </div>

              <h4>
                {dragging
                  ? "Déposez vos fichiers ici"
                  : "Déposez vos fichiers dans votre atelier"}
              </h4>

              <p>Ou cliquez ici pour parcourir votre ordinateur</p>

              <span className="drop-formats">
                AUDIO · VIDÉO · IMAGE · DOCUMENT
              </span>
            </div>

            <div className="queue-toolbar">
              <div className="queue-title">
                <span>FICHIERS</span>
                <span className="queue-count">{files.length}</span>
              </div>

              {files.length > 0 && (
                <button
                  className="text-button"
                  onClick={clearQueue}
                  disabled={isConverting}
                >
                  <Trash2 size={14} /> Vider la liste
                </button>
              )}
            </div>

            <div className="file-list">
              {files.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <FileVideo size={32} />
                  </div>

                  <h4>Aucun fichier pour le moment</h4>

                  <p>
                    Glissez vos fichiers dans la zone ci-dessus pour commencer.
                  </p>
                </div>
              ) : (
                files.map((file) => {
                  const Icon = CATEGORY_ICONS[file.category];
                  const availableFormats = getAvailableFormats(file);
                  const supported = availableFormats.length > 0;

                  return (
                    <div className="file-row" key={file.id}>
                      <div className="file-type-icon">
                        <Icon size={22} />
                      </div>

                      <div className="file-information">
                        <strong title={file.name}>
                          {file.name}
                        </strong>

                        <span>
                          {getExtension(file.name).toUpperCase()}
                        </span>

                        {!supported && (
                          <span className="file-error-message">
                            Format non pris en charge
                          </span>
                        )}

                        {file.error && (
                          <span
                            className="file-error-message"
                            title={file.error}
                          >
                            {file.error.slice(0, 150)}
                          </span>
                        )}
                      </div>

                      {activeMode === "conversion" && (
                        <div className="file-format">
                          <span>FORMAT DE SORTIE</span>

                          <select
                            value={file.format}
                            disabled={
                              isConverting ||
                              !supported ||
                              file.status === "processing"
                            }
                            onChange={(event) =>
                              changeFormat(file.id, event.target.value)
                            }
                          >
                            {availableFormats.map((format) => (
                              <option key={format} value={format}>
                                {format.toUpperCase()}
                              </option>
                            ))}

                            {!supported && (
                              <option value="">
                                Indisponible
                              </option>
                            )}
                          </select>
                        </div>
                      )}

                      {activeMode === "compression" && (
                        <div className="file-format compression-file-format">
                          <span>FORMAT CONSERVÉ</span>
                          <strong>
                            {getExtension(file.name).toUpperCase()}
                          </strong>
                        </div>
                      )}

                      <div className="file-row-status">
                        {renderStatus(file)}
                      </div>

                      <div className="file-row-actions">
                        {file.status === "error" && !isConverting && (
                          <button
                            className="icon-button small"
                            title="Réessayer"
                            onClick={() => resetFile(file)}
                          >
                            <RefreshCw size={15} />
                          </button>
                        )}

                        <button
                          className="icon-button small"
                          title="Supprimer"
                          disabled={isConverting}
                          onClick={() => removeFile(file.id)}
                        >
                          <X size={17} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {isConverting && (
              <div className="progress-panel">
                <div className="progress-heading">
                  <span>
                    <Loader2 size={14} className="spin" />

                    {isCancelling
                      ? "Annulation en cours..."
                      : `${currentAction === "compression" ? "Compression" : "Conversion"} : ${currentFile}`}
                  </span>

                  <strong>{Math.round(progress)}%</strong>
                </div>

                <div
                  className="progress-track"
                  role="progressbar"
                  aria-valuenow={Math.round(progress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>

                <div className="progress-details">
                  <span>
                    <Clock3 size={13} />
                    Écoulé : {formatTime(progressInfo.elapsed)}
                  </span>

                  <span>
                    Temps restant estimé :{" "}
                    {estimatedRemaining === null
                      ? "Calcul..."
                      : formatTime(estimatedRemaining)}
                  </span>
                </div>
              </div>
            )}

            {/* PANNEAU DE CONVERSION */}
            {activeMode === "conversion" && !isConverting && (
              <div className="mode-settings conversion-mode-settings">
                <div className="mode-settings-heading">
                  <div className="mode-settings-icon conversion-mode-icon">
                    <RefreshCcw size={20} />
                  </div>

                  <div>
                    <strong>Options de conversion</strong>
                    <p>
                      Choisis le format de sortie pour chaque fichier.
                    </p>
                  </div>
                </div>

                <p className="mode-description">
                  Le format de sortie est visible dans la liste des fichiers.
                  Les documents utilisent les formats compatibles avec leur
                  type de fichier.
                </p>

                <div className="conversion-resolution">
                  <label htmlFor="conversion-resolution">
                    Résolution vidéo
                  </label>

                  <select
                    id="conversion-resolution"
                    value={preferences.resolution}
                    onChange={(event) =>
                      updatePreference("resolution", event.target.value)
                    }
                  >
                    <option value="original">Conserver l'originale</option>
                    <option value="1920x1080">1080p</option>
                    <option value="1280x720">720p</option>
                    <option value="854x480">480p</option>
                    <option value="640x360">360p</option>
                  </select>
                </div>
              </div>
            )}

            {/* PANNEAU DE COMPRESSION */}
            {activeMode === "compression" && !isConverting && (
              <div className="compression-settings mode-settings">
                <div className="mode-settings-heading compression-settings-heading">
                  <div className="mode-settings-icon compression-mode-icon">
                    <SlidersHorizontal size={20} />
                  </div>

                  <div>
                    <strong>Options de compression</strong>
                    <p>
                      Choisis comment tu souhaites réduire ton fichier.
                    </p>
                  </div>
                </div>

                <div className="compression-mode-options">
                  <button
                    type="button"
                    className={`compression-mode-card ${compressionMode === "size" ? "selected" : ""}`}
                    onClick={() => setCompressionMode("size")}
                  >
                    <strong>Poids cible</strong>
                    <span>
                      Définir la taille finale souhaitée en Mo.
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`compression-mode-card ${compressionMode === "quality" ? "selected" : ""}`}
                    onClick={() => setCompressionMode("quality")}
                  >
                    <strong>Qualité souhaitée</strong>
                    <span>
                      Choisir le niveau de compression.
                    </span>
                  </button>
                </div>

                {compressionMode === "size" ? (
                  <div className="target-size-area">
                    <label htmlFor="target-size">
                      Poids cible du fichier
                    </label>

                    <div className="target-size-control">
                      <input
                        id="target-size"
                        type="number"
                        min="1"
                        max="10000"
                        value={targetSizeMB}
                        onChange={(event) => {
                          const value = Number(event.target.value);

                          setTargetSizeMB(
                            Number.isFinite(value) ? value : 1
                          );
                        }}
                      />

                      <span>Mo</span>
                    </div>

                    <p className="compression-help">
                      La taille finale peut légèrement varier. Cette méthode
                      fonctionne pour les vidéos et les fichiers audio
                      compressibles. Pour les images, choisis
                      « Qualité souhaitée ».
                    </p>
                  </div>
                ) : (
                  <div className="compression-quality-area">
                    <label htmlFor="compression-quality">
                      Niveau de compression
                    </label>

                    <select
                      id="compression-quality"
                      value={compressionQuality}
                      onChange={(event) =>
                        setCompressionQuality(
                          event.target.value as CompressionQuality
                        )
                      }
                    >
                      <option value="high">
                        Haute qualité — moins de perte
                      </option>

                      <option value="medium">
                        Équilibrée — compromis qualité et poids
                      </option>

                      <option value="low">
                        Forte compression — fichier plus léger
                      </option>
                    </select>

                    <p className="compression-help">
                      Le résultat dépend du format et du contenu du fichier.
                      Pour les images PNG, la compression reste sans perte.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="conversion-footer">
              <div className="conversion-info">
                <Music2 size={17} />

                <span>
                  {isConverting
                    ? `${currentAction === "compression" ? "Compression" : "Conversion"} en cours : ${currentFile}`
                    : engineStatus === "ready"
                      ? `${supportedPendingCount} fichier(s) prêt(s)`
                      : "En attente du moteur FFmpeg"}
                </span>
              </div>

              {isConverting ? (
                <button
                  className="cancel-button"
                  onClick={cancelConversion}
                  disabled={isCancelling}
                >
                  {isCancelling ? (
                    <>
                      <Loader2 size={17} className="spin" />
                      Annulation...
                    </>
                  ) : (
                    <>
                      <Ban size={17} />
                      Annuler
                    </>
                  )}
                </button>
              ) : activeMode === null ? (
                <div className="mode-selection">
                  <button
                    className="mode-choice-button convert-choice"
                    onClick={() => setActiveMode("conversion")}
                    disabled={
                      engineStatus !== "ready" ||
                      supportedPendingCount === 0
                    }
                  >
                    <RefreshCcw size={21} />

                    <span>
                      <strong>CONVERTIR</strong>
                      <small>
                        Changer le format d'un fichier
                      </small>
                    </span>
                  </button>

                  <button
                    className="mode-choice-button compress-choice"
                    onClick={() => setActiveMode("compression")}
                    disabled={
                      engineStatus !== "ready" ||
                      supportedPendingCount === 0
                    }
                  >
                    <SlidersHorizontal size={21} />

                    <span>
                      <strong>COMPRESSER</strong>
                      <small>
                        Réduire le poids d'un fichier
                      </small>
                    </span>
                  </button>
                </div>
              ) : (
                <div className="conversion-actions">
                  <button
                    className="secondary-button"
                    onClick={() => setActiveMode(null)}
                  >
                    <ArrowLeft size={16} />
                    Retour
                  </button>

                  <button
                    className={
                      activeMode === "conversion"
                        ? "convert-launch-button"
                        : "compress-launch-button"
                    }
                    onClick={() => startProcessing(activeMode)}
                    disabled={
                      engineStatus !== "ready" ||
                      supportedPendingCount === 0
                    }
                  >
                    {activeMode === "conversion" ? (
                      <>
                        <RefreshCcw size={17} />
                        LANCER LA CONVERSION
                      </>
                    ) : (
                      <>
                        <SlidersHorizontal size={17} />
                        LANCER LA COMPRESSION
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
        <footer className="creator-credit">
      Create by Wallace🌹
    </footer>
      </main>

      {/* NOTIFICATION */}
      {notification && (
        <div className="notification">
          <CheckCircle2 size={17} />

          {notification}

          <button onClick={() => setNotification("")}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* PARAMÈTRES */}
      {showSettings && (
        <div
          className="modal-overlay"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="settings-modal settings-modal-wide"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">CONFIGURATION</span>
                <h3>Paramètres</h3>
              </div>

              <button
                className="icon-button"
                onClick={() => setShowSettings(false)}
              >
                <X size={19} />
              </button>
            </div>

            <div className="settings-section-title">
              <SlidersHorizontal size={16} />
              Préférences d'affichage
            </div>

            <div className="settings-item">
              <div>
                <strong>Thème de l'application</strong>
                <p>Choisis ton apparence préférée.</p>
              </div>

              <select
                value={preferences.theme}
                onChange={(event) =>
                  updatePreference(
                    "theme",
                    event.target.value as Theme
                  )
                }
              >
                <option value="dark">Sombre</option>
                <option value="light">Clair</option>
              </select>
            </div>

            <div className="settings-section-title">
              <FolderOpen size={16} />
              Dossier de destination
            </div>

            <div className="settings-item folder-setting">
              <div>
                <strong>Dossier de sortie par défaut</strong>

                <p>
                  {preferences.outputFolder ||
                    "La fenêtre de sauvegarde proposera le dossier par défaut."}
                </p>
              </div>

              <button
                className="secondary-button"
                onClick={chooseOutputFolder}
              >
                Parcourir
              </button>
            </div>

            {preferences.outputFolder && (
              <button
                className="text-button"
                onClick={() =>
                  updatePreference("outputFolder", "")
                }
              >
                Réinitialiser le dossier
              </button>
            )}

            <div className="settings-section-title">
              <Settings size={16} />
              Moteur de conversion
            </div>

            <div className="settings-item">
              <div>
                <strong>FFmpeg</strong>
                <p>{engineMessage}</p>
              </div>

              <span className={`engine-dot ${engineStatus}`} />
            </div>

            <p className="settings-note">
              FFmpeg gère la conversion et la compression des fichiers
              audio, vidéo et image. Les documents compatibles utilisent
              LibreOffice. La compression des documents n'est pas proposée.
            </p>

            <button
              className="primary-button modal-close"
              onClick={() => setShowSettings(false)}
            >
              Terminé
            </button>
          </div>
        </div>
      )}

      {/* HISTORIQUE */}
      {showHistory && (
        <div
          className="modal-overlay"
          onClick={() => setShowHistory(false)}
        >
          <div
            className="settings-modal history-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">MEDIA CONVERTER</span>
                <h3>Historique des traitements</h3>
              </div>

              <button
                className="icon-button"
                onClick={() => setShowHistory(false)}
              >
                <X size={19} />
              </button>
            </div>

            <div className="history-toolbar">
              <span>{history.length} traitement(s)</span>

              <button
                className="text-button"
                onClick={() => {
                  if (window.confirm("Effacer tout l'historique ?")) {
                    setHistory([]);
                  }
                }}
                disabled={history.length === 0}
              >
                <Trash2 size={14} /> Effacer
              </button>
            </div>

            <div className="history-list">
              {history.length === 0 ? (
                <div className="empty-state">
                  <History size={30} />

                  <h4>Aucun traitement enregistré</h4>

                  <p>
                    Vos prochains traitements apparaîtront ici.
                  </p>
                </div>
              ) : (
                history.map((entry) => (
                  <div className="history-entry" key={entry.id}>
                    <div className="history-entry-icon">
                      {entry.status === "done" ? (
                        <CheckCircle2 size={19} />
                      ) : (
                        <AlertCircle size={19} />
                      )}
                    </div>

                    <div className="history-entry-info">
                      <strong>{entry.source}</strong>

                      <span>
                        {entry.format} · {entry.date}
                      </span>

                      <small title={entry.destination}>
                        Destination : {entry.destination}
                      </small>

                      {entry.message && (
                        <small className="file-error-message">
                          {entry.message.slice(0, 180)}
                        </small>
                      )}
                    </div>

                    <span className={`file-status ${entry.status}`}>
                      {entry.status === "done"
                        ? "Terminé"
                        : "Erreur"}
                    </span>
                  </div>
                ))
              )}
            </div>

            <button
              className="primary-button modal-close"
              onClick={() => setShowHistory(false)}
            >
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
    
  );
}

export default App;
