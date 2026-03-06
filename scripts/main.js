import { openNpcImageBrowser } from "./image-browser.js";

const MODULE_ID = "npc-portrait-overlay";
const STATE_SETTING_KEY = "overlayState";
const LAST_FOLDER_SETTING_KEY = "lastUsedFolder";
const DEFAULT_PICKER_FOLDER = "images/red-sun/common/kepta";

const MAX_COLUMNS = 4;
const GAP_PX = 24;
const VIEWPORT_PADDING_PX = 48;
const PORTRAIT_BOX_WIDTH_RATIO = 0.8;

const MIN_IMAGE_PX = 120;
const MAX_IMAGE_PX = 700;

const BACKDROP_ALPHA = 0.55;
const OVERLAY_Z_INDEX = 999999;

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

function normalizeImagePaths(imagePaths) {
  if (!Array.isArray(imagePaths)) return [];

  const cleanPaths = imagePaths
    .filter(path => typeof path === "string" && path.trim().length > 0)
    .map(path => path.trim());

  return [...new Set(cleanPaths)];
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

// -----------------------------------------------------------------------------
// PIXI OVERLAY
// -----------------------------------------------------------------------------

const PixiOverlay = {
  root: null,
  backdrop: null,
  grid: null,
  sprites: new Map(),
  textures: new Map(),
  hitAreas: new Map(),
  layoutRaf: null,
  domListenersAttached: false,
  hoveredImagePath: null,
  currentCursor: ""
};

const OverlayRuntime = {
  pendingImagePaths: [],
  restoreTimer: null,
  restoreAttempts: 0
};

function isCanvasReady() {
  return Boolean(canvas?.ready && canvas?.app && canvas?.interface);
}

function getCanvasDomElement() {
  return canvas?.app?.view ?? null;
}

function forceOverlayOnTop() {
  if (!isCanvasReady() || !PixiOverlay.root) return;

  canvas.interface.sortableChildren = true;
  PixiOverlay.root.zIndex = OVERLAY_Z_INDEX;

  try {
    canvas.interface.sortChildren();
  } catch (_) {}

  try {
    if (PixiOverlay.root.parent === canvas.interface) {
      canvas.interface.removeChild(PixiOverlay.root);
      canvas.interface.addChild(PixiOverlay.root);
    } else {
      canvas.interface.addChild(PixiOverlay.root);
    }
  } catch (_) {}
}

function setCanvasCursor(cursorStyle = "") {
  const view = getCanvasDomElement();
  if (!view) return;

  if (PixiOverlay.currentCursor === cursorStyle) return;
  PixiOverlay.currentCursor = cursorStyle;
  view.style.cursor = cursorStyle;
}

function clearHoveredImage() {
  PixiOverlay.hoveredImagePath = null;
  setCanvasCursor("");
}

function getCanvasClientPoint(event) {
  if (!event) return null;

  const clientX = typeof event.clientX === "number"
    ? event.clientX
    : (typeof event?.touches?.[0]?.clientX === "number" ? event.touches[0].clientX : null);

  const clientY = typeof event.clientY === "number"
    ? event.clientY
    : (typeof event?.touches?.[0]?.clientY === "number" ? event.touches[0].clientY : null);

  if (clientX == null || clientY == null) return null;
  return { clientX, clientY };
}

function eventToGridLocal(event) {
  const point = getCanvasClientPoint(event);
  const view = getCanvasDomElement();

  if (!point || !view || !PixiOverlay.grid) return null;

  const rect = view.getBoundingClientRect();
  const x = point.clientX - rect.left;
  const y = point.clientY - rect.top;

  return PixiOverlay.grid.toLocal(new PIXI.Point(x, y));
}

function getHitImagePathAtEvent(event) {
  const local = eventToGridLocal(event);
  if (!local) return null;

  for (const [imagePath, bounds] of PixiOverlay.hitAreas.entries()) {
    const withinX = local.x >= bounds.x && local.x <= (bounds.x + bounds.width);
    const withinY = local.y >= bounds.y && local.y <= (bounds.y + bounds.height);

    if (withinX && withinY) return imagePath;
  }

  return null;
}

function onCanvasPointerMove(event) {
  if (!game.user.isGM) {
    clearHoveredImage();
    return;
  }

  const imagePath = getHitImagePathAtEvent(event);
  PixiOverlay.hoveredImagePath = imagePath;
  setCanvasCursor(imagePath ? "pointer" : "");
}

function onCanvasPointerLeave() {
  clearHoveredImage();
}

async function onCanvasContextMenu(event) {
  if (!game.user.isGM) return;

  const imagePath = getHitImagePathAtEvent(event);
  if (!imagePath) return;

  event.preventDefault();
  event.stopPropagation();

  await removeImageToAll(imagePath);
}

function attachCanvasDomListeners() {
  if (PixiOverlay.domListenersAttached) return;

  const view = getCanvasDomElement();
  if (!view) return;

  view.addEventListener("pointermove", onCanvasPointerMove);
  view.addEventListener("pointerleave", onCanvasPointerLeave);
  view.addEventListener("contextmenu", onCanvasContextMenu);

  PixiOverlay.domListenersAttached = true;
}

function detachCanvasDomListeners() {
  if (!PixiOverlay.domListenersAttached) return;

  const view = getCanvasDomElement();
  if (view) {
    view.removeEventListener("pointermove", onCanvasPointerMove);
    view.removeEventListener("pointerleave", onCanvasPointerLeave);
    view.removeEventListener("contextmenu", onCanvasContextMenu);
  }

  PixiOverlay.domListenersAttached = false;
  clearHoveredImage();
}

function destroyPixiOverlay({ clearTextures = false } = {}) {
  if (PixiOverlay.layoutRaf) {
    cancelAnimationFrame(PixiOverlay.layoutRaf);
    PixiOverlay.layoutRaf = null;
  }

  detachCanvasDomListeners();

  try {
    if (PixiOverlay.root?.parent) PixiOverlay.root.parent.removeChild(PixiOverlay.root);
  } catch (_) {}

  try {
    PixiOverlay.sprites.forEach((sprite) => {
      try {
        sprite.destroy({ children: true, texture: false, baseTexture: false });
      } catch (_) {}
    });
  } finally {
    PixiOverlay.sprites.clear();
  }

  PixiOverlay.hitAreas.clear();

  if (clearTextures) {
    try {
      PixiOverlay.textures.forEach((texture) => {
        try {
          texture.destroy(true);
        } catch (_) {}
      });
    } finally {
      PixiOverlay.textures.clear();
    }
  }

  try {
    PixiOverlay.backdrop?.destroy();
  } catch (_) {}

  try {
    PixiOverlay.grid?.destroy({ children: true });
  } catch (_) {}

  try {
    PixiOverlay.root?.destroy({ children: true });
  } catch (_) {}

  PixiOverlay.root = null;
  PixiOverlay.backdrop = null;
  PixiOverlay.grid = null;
}

function ensurePixiOverlay() {
  if (!isCanvasReady()) return false;

  if (PixiOverlay.root && PixiOverlay.root.parent) {
    forceOverlayOnTop();
    attachCanvasDomListeners();
    return true;
  }

  const root = new PIXI.Container();
  root.name = `${MODULE_ID}-root`;
  root.zIndex = OVERLAY_Z_INDEX;
  root.eventMode = "none";
  root.interactiveChildren = false;

  const backdrop = new PIXI.Graphics();
  backdrop.name = `${MODULE_ID}-backdrop`;
  backdrop.eventMode = "none";

  const grid = new PIXI.Container();
  grid.name = `${MODULE_ID}-grid`;
  grid.eventMode = "none";
  grid.interactiveChildren = false;

  root.addChild(backdrop);
  root.addChild(grid);

  canvas.interface.addChild(root);

  PixiOverlay.root = root;
  PixiOverlay.backdrop = backdrop;
  PixiOverlay.grid = grid;

  forceOverlayOnTop();
  attachCanvasDomListeners();
  return true;
}

function getScreenSize() {
  const w = canvas?.app?.renderer?.screen?.width ?? window.innerWidth ?? 1600;
  const h = canvas?.app?.renderer?.screen?.height ?? window.innerHeight ?? 900;
  return { w, h };
}

function toInterfaceLocal(screenX, screenY) {
  return canvas.interface.toLocal(new PIXI.Point(screenX, screenY));
}

function computeMaxSpriteBoxSize(imageCount, screenW, screenH) {
  const columns = Math.min(imageCount, MAX_COLUMNS);
  const rows = Math.ceil(imageCount / MAX_COLUMNS);

  const usableWidth = Math.max(100, screenW - (VIEWPORT_PADDING_PX * 2));
  const usableHeight = Math.max(100, screenH - (VIEWPORT_PADDING_PX * 2));

  const totalHorizontalGap = Math.max(0, (columns - 1) * GAP_PX);
  const totalVerticalGap = Math.max(0, (rows - 1) * GAP_PX);

  const maxByWidth = Math.floor((usableWidth - totalHorizontalGap) / columns);
  const maxByHeight = Math.floor((usableHeight - totalVerticalGap) / rows);

  const size = Math.min(maxByWidth, maxByHeight, MAX_IMAGE_PX);
  return Math.max(MIN_IMAGE_PX, size);
}

function scheduleLayout() {
  if (!PixiOverlay.root) return;

  if (PixiOverlay.layoutRaf) cancelAnimationFrame(PixiOverlay.layoutRaf);
  PixiOverlay.layoutRaf = requestAnimationFrame(() => {
    PixiOverlay.layoutRaf = null;
    layoutPixiOverlay();
  });
}

function drawBackdrop() {
  if (!PixiOverlay.backdrop) return;

  const { w, h } = getScreenSize();
  const topLeft = toInterfaceLocal(0, 0);
  const bottomRight = toInterfaceLocal(w, h);

  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;

  PixiOverlay.backdrop.clear();
  PixiOverlay.backdrop.beginFill(0x000000, BACKDROP_ALPHA);
  PixiOverlay.backdrop.drawRect(topLeft.x, topLeft.y, width, height);
  PixiOverlay.backdrop.endFill();
}

function layoutPixiOverlay() {
  if (!ensurePixiOverlay()) return;

  forceOverlayOnTop();
  drawBackdrop();
  PixiOverlay.hitAreas.clear();

  const sprites = PixiOverlay.grid.children.filter(child => child instanceof PIXI.Sprite);
  const count = sprites.length;

  if (!count) {
    destroyPixiOverlay();
    return;
  }

  const { w: screenW, h: screenH } = getScreenSize();
  const columns = Math.min(count, MAX_COLUMNS);
  const rows = Math.ceil(count / MAX_COLUMNS);

  const zoom = canvas?.stage?.scale?.x ?? 1;
  const boxSizeScreen = computeMaxSpriteBoxSize(count, screenW, screenH);

  const boxSize = boxSizeScreen / zoom;
  const gap = GAP_PX / zoom;

  const boxH = boxSize;
  const boxW = boxSize * PORTRAIT_BOX_WIDTH_RATIO;

  const stepX = boxW + gap;
  const stepY = boxH + gap;

  const center = toInterfaceLocal(screenW / 2, screenH / 2);
  PixiOverlay.grid.position.set(center.x, center.y);

  const xOffset = ((columns - 1) * stepX) / 2;
  const yOffset = ((rows - 1) * stepY) / 2;

  sprites.forEach((sprite, index) => {
    const col = index % MAX_COLUMNS;
    const row = Math.floor(index / MAX_COLUMNS);

    const cellX = (col * stepX) - xOffset;
    const cellY = (row * stepY) - yOffset;

    sprite.position.set(cellX, cellY);

    const texW = sprite.texture?.width ?? 1;
    const texH = sprite.texture?.height ?? 1;
    const scale = Math.min(boxW / texW, boxH / texH);

    sprite.anchor.set(0.5, 0.5);
    sprite.scale.set(scale, scale);

    const spriteWidth = sprite.width;
    const spriteHeight = sprite.height;

    const imagePath = sprite._npcPortraitImagePath;
    if (imagePath) {
      PixiOverlay.hitAreas.set(imagePath, {
        x: sprite.x - (spriteWidth / 2),
        y: sprite.y - (spriteHeight / 2),
        width: spriteWidth,
        height: spriteHeight,
        sprite
      });
    }
  });

  if (PixiOverlay.hoveredImagePath && !PixiOverlay.hitAreas.has(PixiOverlay.hoveredImagePath)) {
    clearHoveredImage();
  }
}

async function loadTextureForPath(imagePath) {
  if (PixiOverlay.textures.has(imagePath)) return PixiOverlay.textures.get(imagePath);

  let texture;
  try {
    if (typeof loadTexture === "function") {
      texture = await loadTexture(imagePath);
    } else {
      texture = PIXI.Texture.from(imagePath);
    }
  } catch (error) {
    console.error(error);
    return null;
  }

  if (!texture) return null;
  PixiOverlay.textures.set(imagePath, texture);
  return texture;
}

async function renderPixiFromPaths(imagePaths) {
  if (!ensurePixiOverlay()) return;

  const normalized = normalizeImagePaths(imagePaths);
  OverlayRuntime.pendingImagePaths = normalized;

  PixiOverlay.grid.removeChildren();

  for (const existingPath of Array.from(PixiOverlay.sprites.keys())) {
    if (!normalized.includes(existingPath)) {
      const sprite = PixiOverlay.sprites.get(existingPath);
      try {
        sprite?.destroy({ children: true, texture: false, baseTexture: false });
      } catch (_) {}
      PixiOverlay.sprites.delete(existingPath);
      PixiOverlay.hitAreas.delete(existingPath);
    }
  }

  for (const imagePath of normalized) {
    let sprite = PixiOverlay.sprites.get(imagePath);

    if (!sprite) {
      const texture = await loadTextureForPath(imagePath);
      if (!texture) continue;

      sprite = new PIXI.Sprite(texture);
      sprite.name = `${MODULE_ID}-sprite`;
      sprite.anchor.set(0.5, 0.5);
      sprite.eventMode = "none";
      sprite.interactive = false;
      sprite.interactiveChildren = false;
      sprite._npcPortraitImagePath = imagePath;

      PixiOverlay.sprites.set(imagePath, sprite);
    } else {
      sprite._npcPortraitImagePath = imagePath;
      sprite.eventMode = "none";
      sprite.interactive = false;
      sprite.interactiveChildren = false;
    }

    PixiOverlay.grid.addChild(sprite);
  }

  forceOverlayOnTop();
  scheduleLayout();
}

function cancelScheduledRestore() {
  if (OverlayRuntime.restoreTimer) {
    clearTimeout(OverlayRuntime.restoreTimer);
    OverlayRuntime.restoreTimer = null;
  }
}

function applyLocalImagesState(imagePaths) {
  const normalizedPaths = normalizeImagePaths(imagePaths);
  OverlayRuntime.pendingImagePaths = normalizedPaths;

  log("applyLocalImagesState", {
    canvasReady: isCanvasReady(),
    imagePaths: normalizedPaths
  });

  if (!isCanvasReady()) return normalizedPaths;

  if (normalizedPaths.length) {
    void renderPixiFromPaths(normalizedPaths);
  } else {
    hideOverlay();
  }

  return normalizedPaths;
}

function scheduleRestoreFromState({ resetAttempts = false } = {}) {
  if (resetAttempts) OverlayRuntime.restoreAttempts = 0;
  cancelScheduledRestore();

  const tryRestore = async () => {
    OverlayRuntime.restoreTimer = null;
    OverlayRuntime.restoreAttempts += 1;

    const state = getState();
    const imagePaths = normalizeImagePaths(state.imagePaths);

    log("scheduleRestoreFromState attempt", {
      attempt: OverlayRuntime.restoreAttempts,
      canvasReady: isCanvasReady(),
      imagePaths
    });

    if (!isCanvasReady()) {
      if (OverlayRuntime.restoreAttempts < 20) {
        OverlayRuntime.restoreTimer = setTimeout(tryRestore, 250);
      }
      return;
    }

    if (imagePaths.length) {
      OverlayRuntime.pendingImagePaths = imagePaths;
      await renderPixiFromPaths(imagePaths);
    } else {
      hideOverlay();
    }
  };

  OverlayRuntime.restoreTimer = setTimeout(tryRestore, 100);
}

// Public render entrypoints
function showImages(imagePaths) {
  const normalizedPaths = normalizeImagePaths(imagePaths);
  OverlayRuntime.pendingImagePaths = normalizedPaths;

  if (!isCanvasReady()) {
    scheduleRestoreFromState({ resetAttempts: true });
    return normalizedPaths;
  }

  return applyLocalImagesState(normalizedPaths);
}

function hideOverlay() {
  log("hideOverlay");
  OverlayRuntime.pendingImagePaths = [];
  destroyPixiOverlay();
}

function forceRemoveLocalOverlay() {
  destroyPixiOverlay({ clearTextures: false });
}

// -----------------------------------------------------------------------------
// FILE BROWSING / PICKER
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------------

async function applyImagesState(imagePaths) {
  const normalizedPaths = normalizeImagePaths(imagePaths);

  await setState({
    imagePaths: normalizedPaths
  });

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
  if (!game.user.isGM) return [];

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

  if (!selectedPath) return null;

  await setLastUsedFolder(getParentFolder(selectedPath));
  await addImageToAll(selectedPath);

  return selectedPath;
}

async function restoreFromState() {
  const state = getState();
  log("restoreFromState", state);

  const imagePaths = normalizeImagePaths(state.imagePaths);
  OverlayRuntime.pendingImagePaths = imagePaths;

  if (!isCanvasReady()) {
    scheduleRestoreFromState();
    return imagePaths;
  }

  if (imagePaths.length) {
    await renderPixiFromPaths(imagePaths);
  } else {
    hideOverlay();
  }

  return imagePaths;
}

// Keep the overlay stable when the canvas changes
function onCanvasReady() {
  forceOverlayOnTop();
  attachCanvasDomListeners();
  scheduleRestoreFromState({ resetAttempts: true });
}

function onCanvasTearDown() {
  cancelScheduledRestore();
  destroyPixiOverlay({ clearTextures: false });
}

function onCanvasPan() {
  scheduleLayout();
}

function onWindowResize() {
  scheduleLayout();
}

// -----------------------------------------------------------------------------
// INIT / READY
// -----------------------------------------------------------------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, STATE_SETTING_KEY, {
    name: "Overlay State",
    scope: "world",
    config: false,
    type: Object,
    default: getDefaultState(),
    onChange: (value) => {
      const imagePaths = normalizeImagePaths(value?.imagePaths);
      log("overlayState onChange", imagePaths);
      applyLocalImagesState(imagePaths);
    }
  });

  game.settings.register(MODULE_ID, LAST_FOLDER_SETTING_KEY, {
    name: "Last Used Folder",
    scope: "client",
    config: false,
    type: String,
    default: DEFAULT_PICKER_FOLDER
  });
});

Hooks.on("canvasReady", onCanvasReady);
Hooks.on("canvasTearDown", onCanvasTearDown);
Hooks.on("canvasPan", onCanvasPan);

Hooks.once("ready", async () => {
  globalThis.NpcPortraitOverlay = {
    resolveFolderImages,
    showImages,
    setImagesToAll,
    addImageToAll,
    removeImageToAll,
    clearAll,
    showFolderToAll,
    pickAndAddImage,
    restoreFromState,
    forceRemoveLocalOverlay,
    openImageBrowser: openNpcImageBrowser
  };

  log("API ready", globalThis.NpcPortraitOverlay);

  window.addEventListener("resize", onWindowResize);

  scheduleRestoreFromState({ resetAttempts: true });
});