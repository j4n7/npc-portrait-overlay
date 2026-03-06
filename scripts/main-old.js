// Uses DOM instead of Canvas

const MODULE_ID = "npc-portrait-overlay";
const SOCKET_NAME = `module.${MODULE_ID}`;
const OVERLAY_ID = `${MODULE_ID}-overlay`;
const STATE_SETTING_KEY = "overlayState";
const LAST_FOLDER_SETTING_KEY = "lastUsedFolder";
const DEFAULT_PICKER_FOLDER = "images/red-sun/";

const MAX_COLUMNS = 4;
const GAP_PX = 24;
const VIEWPORT_PADDING_PX = 48;

const MIN_IMAGE_PX = 120;
const MAX_IMAGE_PX = 700;

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"];

function log(...args) {
  console.log(`[${MODULE_ID}]`, ...args);
}

function isImageFile(path) {
  const lowerPath = String(path).toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
}

function getDefaultState() {
  return {
    imagePaths: []
  };
}

function getState() {
  const state = game.settings.get(MODULE_ID, STATE_SETTING_KEY);
  if (!state || typeof state !== "object") return getDefaultState();

  return {
    imagePaths: Array.isArray(state.imagePaths) ? state.imagePaths : []
  };
}

async function setState(state) {
  await game.settings.set(MODULE_ID, STATE_SETTING_KEY, {
    imagePaths: Array.isArray(state?.imagePaths) ? state.imagePaths : []
  });
}

function getLastUsedFolder() {
  const folder = game.settings.get(MODULE_ID, LAST_FOLDER_SETTING_KEY);
  if (typeof folder !== "string" || !folder.trim()) return DEFAULT_PICKER_FOLDER;
  return folder.trim();
}

async function setLastUsedFolder(folderPath) {
  const folder = typeof folderPath === "string" && folderPath.trim()
    ? folderPath.trim()
    : DEFAULT_PICKER_FOLDER;

  await game.settings.set(MODULE_ID, LAST_FOLDER_SETTING_KEY, folder);
}

function getParentFolder(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return DEFAULT_PICKER_FOLDER;

  const parts = filePath.split("/");
  parts.pop();

  const parent = parts.join("/");
  return parent || DEFAULT_PICKER_FOLDER;
}

function normalizeImagePaths(imagePaths) {
  if (!Array.isArray(imagePaths)) return [];

  const cleanPaths = imagePaths
    .filter(path => typeof path === "string" && path.trim().length > 0)
    .map(path => path.trim());

  return [...new Set(cleanPaths)];
}

function removeOverlay() {
  const existingOverlay = document.getElementById(OVERLAY_ID);
  if (existingOverlay) existingOverlay.remove();
}

function computeMaxImageSize(imageCount) {
  const columns = Math.min(imageCount, MAX_COLUMNS);
  const rows = Math.ceil(imageCount / MAX_COLUMNS);

  const viewportWidth = window.innerWidth || 1600;
  const viewportHeight = window.innerHeight || 900;

  const usableWidth = Math.max(100, viewportWidth - (VIEWPORT_PADDING_PX * 2));
  const usableHeight = Math.max(100, viewportHeight - (VIEWPORT_PADDING_PX * 2));

  const totalHorizontalGap = Math.max(0, (columns - 1) * GAP_PX);
  const totalVerticalGap = Math.max(0, (rows - 1) * GAP_PX);

  const maxByWidth = Math.floor((usableWidth - totalHorizontalGap) / columns);
  const maxByHeight = Math.floor((usableHeight - totalVerticalGap) / rows);

  const size = Math.min(maxByWidth, maxByHeight, MAX_IMAGE_PX);
  return Math.max(MIN_IMAGE_PX, size);
}

function createOverlay(imagePaths) {
  removeOverlay();

  const imageCount = imagePaths.length;
  if (!imageCount) return;

  const columns = Math.min(imageCount, MAX_COLUMNS);
  const maxImageSize = computeMaxImageSize(imageCount);

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "99999";
  overlay.style.pointerEvents = "none";

  const backdrop = document.createElement("div");
  backdrop.style.position = "absolute";
  backdrop.style.inset = "0";
  backdrop.style.background = "rgba(0, 0, 0, 0.55)";
  backdrop.style.pointerEvents = "none";

  const content = document.createElement("div");
  content.style.position = "absolute";
  content.style.inset = "0";
  content.style.display = "flex";
  content.style.alignItems = "center";
  content.style.justifyContent = "center";
  content.style.padding = `${VIEWPORT_PADDING_PX}px`;
  content.style.boxSizing = "border-box";
  content.style.pointerEvents = "none";

  const grid = document.createElement("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = `repeat(${columns}, auto)`;
  grid.style.gap = `${GAP_PX}px`;
  grid.style.justifyContent = "center";
  grid.style.alignContent = "center";
  grid.style.alignItems = "center";
  grid.style.maxWidth = "100%";
  grid.style.maxHeight = "100%";
  grid.style.pointerEvents = "auto";

  for (const imagePath of imagePaths) {
    const img = document.createElement("img");
    img.src = imagePath;
    img.alt = "Portrait";
    img.draggable = false;
    img.style.display = "block";
    img.style.maxWidth = `${maxImageSize}px`;
    img.style.maxHeight = `${maxImageSize}px`;
    img.style.width = "auto";
    img.style.height = "auto";
    img.style.objectFit = "contain";
    img.style.border = "none";
    img.style.background = "transparent";
    img.style.boxShadow = "none";
    img.style.pointerEvents = "auto";
    img.style.cursor = game.user.isGM ? "pointer" : "default";

    img.dataset.imagePath = imagePath;

    img.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!game.user.isGM) return;

      log("context remove", imagePath);
      await removeImageToAll(imagePath);
    });

    grid.appendChild(img);
  }

  content.appendChild(grid);
  overlay.appendChild(backdrop);
  overlay.appendChild(content);
  document.body.appendChild(overlay);
}

function showImages(imagePaths) {
  const normalizedPaths = normalizeImagePaths(imagePaths);
  log("showImages", normalizedPaths);

  if (!normalizedPaths.length) {
    hideOverlay();
    return [];
  }

  createOverlay(normalizedPaths);
  return normalizedPaths;
}

async function resolveFolderImages(folderPath) {
  log("resolveFolderImages", folderPath);

  let browseResult;
  try {
    browseResult = await FilePicker.browse("data", folderPath);
  } catch (error) {
    console.error(error);
    ui.notifications.error(`Could not browse folder: ${folderPath}`);
    return [];
  }

  const imagePaths = (browseResult?.files ?? [])
    .filter(isImageFile)
    .sort((a, b) => a.localeCompare(b));

  log("resolved imagePaths", imagePaths);

  if (!imagePaths.length) {
    ui.notifications.warn(`No image files found in: ${folderPath}`);
    return [];
  }

  return imagePaths;
}

function hideOverlay() {
  log("hideOverlay");
  removeOverlay();
}

function restoreLocalOverlayFromCurrentState() {
  const currentState = getState();
  const imagePaths = normalizeImagePaths(currentState.imagePaths);

  if (imagePaths.length) {
    showImages(imagePaths);
  } else {
    hideOverlay();
  }
}

function broadcast(payload) {
  game.socket.emit(SOCKET_NAME, {
    ...payload,
    moduleId: MODULE_ID,
    senderId: game.user.id
  });
}

async function applyImagesState(imagePaths, { broadcastToOthers = true } = {}) {
  const normalizedPaths = normalizeImagePaths(imagePaths);

  await setState({
    imagePaths: normalizedPaths
  });

  if (normalizedPaths.length) {
    showImages(normalizedPaths);
  } else {
    hideOverlay();
  }

  if (broadcastToOthers) {
    broadcast({
      action: "setImages",
      imagePaths: normalizedPaths
    });
  }

  return normalizedPaths;
}

async function setImagesToAll(imagePaths) {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  return await applyImagesState(imagePaths);
}

async function addImageToAll(imagePath) {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  const currentState = getState();
  const nextPaths = [...currentState.imagePaths, imagePath];
  return await applyImagesState(nextPaths);
}

async function removeImageToAll(imagePath) {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  const currentState = getState();
  const nextPaths = currentState.imagePaths.filter(path => path !== imagePath);
  return await applyImagesState(nextPaths);
}

async function clearAll() {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  return await applyImagesState([]);
}

async function showFolderToAll(folderPath) {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  const imagePaths = await resolveFolderImages(folderPath);
  if (!imagePaths.length) return [];

  return await setImagesToAll(imagePaths);
}

async function pickAndAddImage() {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return null;
  }

  const startFolder = getLastUsedFolder();

  hideOverlay();

  const selectedPath = await new Promise((resolve) => {
    let finished = false;

    const picker = new FilePicker({
      type: "image",
      current: startFolder,
      source: "data",
      callback: (path) => {
        finished = true;
        resolve(path);
      }
    });

    const originalClose = picker.close.bind(picker);
    picker.close = async (...args) => {
      const result = await originalClose(...args);
      if (!finished) {
        finished = true;
        resolve(null);
      }
      return result;
    };

    picker.render(true);
  });

  if (!selectedPath) {
    restoreLocalOverlayFromCurrentState();
    return null;
  }

  await setLastUsedFolder(getParentFolder(selectedPath));
  await addImageToAll(selectedPath);

  return selectedPath;
}

async function restoreFromState() {
  const state = getState();
  log("restoreFromState", state);

  const imagePaths = normalizeImagePaths(state.imagePaths);

  if (imagePaths.length) {
    showImages(imagePaths);
  } else {
    hideOverlay();
  }
}

async function handleSocketMessage(payload) {
  log("socket payload", payload);

  if (!payload || payload.moduleId !== MODULE_ID) return;
  if (payload.senderId === game.user.id) return;

  if (payload.action === "setImages") {
    const imagePaths = normalizeImagePaths(payload.imagePaths);

    if (imagePaths.length) {
      showImages(imagePaths);
    } else {
      hideOverlay();
    }
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, STATE_SETTING_KEY, {
    name: "Overlay State",
    scope: "world",
    config: false,
    type: Object,
    default: getDefaultState()
  });

  game.settings.register(MODULE_ID, LAST_FOLDER_SETTING_KEY, {
    name: "Last Used Folder",
    scope: "client",
    config: false,
    type: String,
    default: DEFAULT_PICKER_FOLDER
  });
});

Hooks.once("ready", async () => {
  game.socket.on(SOCKET_NAME, handleSocketMessage);

  globalThis.NpcPortraitOverlay = {
    resolveFolderImages,
    showImages,
    setImagesToAll,
    addImageToAll,
    removeImageToAll,
    clearAll,
    showFolderToAll,
    pickAndAddImage,
    restoreFromState
  };

  log("Socket listener ready", SOCKET_NAME);
  log("API ready", globalThis.NpcPortraitOverlay);

  await restoreFromState();
});