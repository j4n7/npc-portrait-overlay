import { openNpcImageBrowser } from "./image-browser.js";

const MODULE_ID = "npc-portrait-overlay";
const STATE_SETTING_KEY = "overlayState";
const LAST_FOLDER_SETTING_KEY = "lastUsedFolder";
const DEFAULT_PICKER_FOLDER = "images/red-sun/common/kepta";

const SOCKET_NAME = `module.${MODULE_ID}`;
const SOCKET_ACTIONS = {
  TOGGLE_CHARACTER_PORTRAIT: "toggleCharacterPortrait"
};
const QUERY_TOGGLE_CHARACTER_PORTRAIT = `${MODULE_ID}.toggleCharacterPortrait`;

const SCENE_CONTROL_NAME = "npc-portrait-overlay__scene-control";
const SCENE_CONTROL_TITLE = "NPC Portraits Overlay";
const SCENE_CONTROL_ICON = "fa-solid fa-theater-masks";

const MAX_COLUMNS = 4;
const GAP_PX = 24;
const VIEWPORT_PADDING_PX = 48;
const PORTRAIT_BOX_WIDTH_RATIO = 0.8;

const MIN_IMAGE_PX = 120;
const MAX_IMAGE_PX = 700;

const BACKDROP_ALPHA = 0.55;
const OVERLAY_Z_INDEX = 999999;
const TARGET_HOVER_PREVIEW_HEIGHT_PX = 1000;
const MAX_HOVER_PREVIEW_SCALE = 2;

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

function getUserCharacter(user = game.user) {
  return user?.character ?? null;
}

function getActorPortraitPath(actor) {
  if (!actor) return null;

  const candidates = [
    actor.img,
    actor.prototypeToken?.texture?.src,
    actor.token?.texture?.src
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function getUserCharacterPortraitPath(user = game.user) {
  const actor = getUserCharacter(user);
  if (!actor) return null;
  return getActorPortraitPath(actor);
}

function canCurrentGmHandleSocket() {
  return game.user?.isGM === true;
}

function emitSocketMessage(payload) {
  log("emitSocketMessage", payload);
  game.socket.emit(SOCKET_NAME, payload);
}

// -----------------------------------------------------------------------------
// SCENE CONTROLS INTEGRATION
// -----------------------------------------------------------------------------

function registerNpcPortraitSceneControl(buttonMetaLookup) {
  if (!game.user.isGM) return;
  if (buttonMetaLookup[SCENE_CONTROL_NAME]) return;

  const maxOrder = Math.max(
    0,
    ...Object.values(buttonMetaLookup).map(button => button?.order ?? 0)
  );

  buttonMetaLookup[SCENE_CONTROL_NAME] = {
    name: SCENE_CONTROL_NAME,
    title: SCENE_CONTROL_TITLE,
    icon: SCENE_CONTROL_ICON,
    tools: [
      {
        name: SCENE_CONTROL_NAME,
        title: SCENE_CONTROL_TITLE,
        icon: SCENE_CONTROL_ICON,
        onClick: () => {
          ui.notifications.info("NPC Portraits Overlay fallback click triggered.");
          openNpcImageBrowser();
        },
        button: true
      }
    ],
    visible: true,
    activeTool: SCENE_CONTROL_NAME,
    order: maxOrder + 1
  };
}

function handleNpcPortraitSceneControlClick(originalFn, event, ...rest) {
  const controlElement = event?.target?.closest?.("[data-control]");
  const controlName = controlElement?.dataset?.control;

  if (controlName === SCENE_CONTROL_NAME) {
    event.preventDefault();
    event.stopPropagation();
    openNpcImageBrowser();
    return;
  }

  return originalFn(event, ...rest);
}

function registerNpcPortraitSceneControlWrapper() {
  if (!globalThis.libWrapper) {
    console.warn(`${MODULE_ID} | libWrapper is required for the scene control button integration.`);
    return;
  }

  libWrapper.register(
    MODULE_ID,
    "ui.controls.options.actions.control",
    function (originalFn, event, ...rest) {
      return handleNpcPortraitSceneControlClick(originalFn, event, ...rest);
    },
    "MIXED"
  );
}

// -----------------------------------------------------------------------------
// PIXI OVERLAY
// -----------------------------------------------------------------------------

const PixiOverlay = {
  root: null,
  backdrop: null,
  grid: null,
  hoverPreviewLayer: null,
  hoverPreviewSprite: null,
  hoverPreviewImagePath: null,
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

function clearHoverPreview() {
  PixiOverlay.hoverPreviewImagePath = null;

  try {
    PixiOverlay.hoverPreviewSprite?.destroy({ children: true, texture: false, baseTexture: false });
  } catch (_) {}

  PixiOverlay.hoverPreviewSprite = null;
}

function getSpriteForImagePath(imagePath) {
  return PixiOverlay.sprites.get(imagePath) ?? null;
}

function getHoverPreviewScale(baseSprite) {
  const baseHeight = Number(baseSprite?.height) || 0;
  if (baseHeight <= 0) return 1.0;

  const rawScale = TARGET_HOVER_PREVIEW_HEIGHT_PX / baseHeight;
  return Math.max(1.0, Math.min(MAX_HOVER_PREVIEW_SCALE, rawScale));
}

function showHoverPreview(imagePath) {
  if (!PixiOverlay.grid || !PixiOverlay.hoverPreviewLayer) return;

  if (!imagePath) {
    clearHoverPreview();
    return;
  }

  if (PixiOverlay.hoverPreviewImagePath === imagePath && PixiOverlay.hoverPreviewSprite) return;

  clearHoverPreview();

  const baseSprite = getSpriteForImagePath(imagePath);
  if (!baseSprite?.texture) return;

  const previewSprite = new PIXI.Sprite(baseSprite.texture);
  previewSprite.name = `${MODULE_ID}-hover-preview`;
  previewSprite.anchor.set(baseSprite.anchor.x, baseSprite.anchor.y);

  const globalPos = baseSprite.getGlobalPosition();
  const localPos = PixiOverlay.hoverPreviewLayer.toLocal(globalPos);
  const hoverScale = getHoverPreviewScale(baseSprite);

  previewSprite.position.set(localPos.x, localPos.y);
  previewSprite.scale.set(
    baseSprite.scale.x * hoverScale,
    baseSprite.scale.y * hoverScale
  );
  previewSprite.eventMode = "none";
  previewSprite.interactive = false;
  previewSprite.interactiveChildren = false;

  PixiOverlay.hoverPreviewLayer.addChild(previewSprite);
  PixiOverlay.hoverPreviewSprite = previewSprite;
  PixiOverlay.hoverPreviewImagePath = imagePath;
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
  const imagePath = getHitImagePathAtEvent(event);

  PixiOverlay.hoveredImagePath = imagePath;

  if (game.user.isGM) {
    setCanvasCursor(imagePath ? "pointer" : "");
  } else {
    setCanvasCursor("");
  }

  if (imagePath) {
    showHoverPreview(imagePath);
  } else {
    clearHoverPreview();
  }
}

function onCanvasPointerLeave() {
  clearHoveredImage();
  clearHoverPreview();
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
  clearHoverPreview();
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
  clearHoverPreview();

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
    PixiOverlay.hoverPreviewLayer?.destroy({ children: true });
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
  PixiOverlay.hoverPreviewLayer = null;
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

  const hoverPreviewLayer = new PIXI.Container();
  hoverPreviewLayer.name = `${MODULE_ID}-hover-preview-layer`;
  hoverPreviewLayer.eventMode = "none";
  hoverPreviewLayer.interactiveChildren = false;

  root.addChild(backdrop);
  root.addChild(grid);
  root.addChild(hoverPreviewLayer);

  canvas.interface.addChild(root);

  PixiOverlay.root = root;
  PixiOverlay.backdrop = backdrop;
  PixiOverlay.grid = grid;
  PixiOverlay.hoverPreviewLayer = hoverPreviewLayer;

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
  clearHoverPreview();

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

  clearHoverPreview();
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

async function addImageToAllAsGm(imagePath) {
  const currentState = getState();
  const nextPaths = [...currentState.imagePaths, imagePath];
  return await applyImagesState(nextPaths);
}

async function removeImageToAllAsGm(imagePath) {
  const currentState = getState();
  const nextPaths = currentState.imagePaths.filter(path => path !== imagePath);
  return await applyImagesState(nextPaths);
}

async function toggleImageToAllAsGm(imagePath) {
  const currentState = getState();
  const currentPaths = normalizeImagePaths(currentState.imagePaths);
  const alreadyShown = currentPaths.includes(imagePath);

  if (alreadyShown) {
    return await removeImageToAllAsGm(imagePath);
  }

  return await addImageToAllAsGm(imagePath);
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

  return await addImageToAllAsGm(imagePath);
}

async function removeImageToAll(imagePath) {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  return await removeImageToAllAsGm(imagePath);
}

async function toggleImageToAll(imagePath) {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can control portraits for everyone.");
    return [];
  }

  return await toggleImageToAllAsGm(imagePath);
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

async function handleSocketMessage(payload) {
  log("handleSocketMessage received", {
    isGM: game.user?.isGM,
    userId: game.user?.id,
    payload
  });

  if (!canCurrentGmHandleSocket()) return;

  const action = payload?.action;
  if (!action) return;

  switch (action) {
    case SOCKET_ACTIONS.TOGGLE_CHARACTER_PORTRAIT: {
      const userId = payload?.userId;
      if (!userId) return;

      const user = game.users.get(userId);
      if (!user) {
        log("Socket user not found", userId);
        return;
      }

      const imagePath = getUserCharacterPortraitPath(user);
      if (!imagePath) {
        log("Socket portrait path not found for user", userId);
        return;
      }

      log("Socket toggling portrait", { userId, imagePath });
      await toggleImageToAllAsGm(imagePath);
      break;
    }

    default:
      log("Unknown socket action", action);
      break;
  }
}

async function toggleMyCharacterInOverlay() {
  const actor = getUserCharacter(game.user);
  log("toggleMyCharacterInOverlay", {
    userId: game.user?.id,
    userName: game.user?.name,
    isGM: game.user?.isGM,
    actorId: actor?.id,
    actorName: actor?.name
  });

  if (!actor) {
    ui.notifications.warn("You do not have an assigned character.");
    return null;
  }

  const imagePath = getActorPortraitPath(actor);
  log("toggleMyCharacterInOverlay portrait", imagePath);

  if (!imagePath) {
    ui.notifications.warn("Your character does not have a valid portrait image.");
    return null;
  }

  if (game.user.isGM) {
    await toggleImageToAllAsGm(imagePath);
    return imagePath;
  }

  const activeGm = game.users.activeGM;
  if (!activeGm) {
    ui.notifications.warn("No active GM is connected.");
    return null;
  }

  const response = await activeGm.query(QUERY_TOGGLE_CHARACTER_PORTRAIT, {
    userId: game.user.id
  }, { timeout: 10000 });

  log("toggleMyCharacterInOverlay query response", response);

  if (!response?.ok) {
    ui.notifications.warn("The GM could not toggle your portrait.");
    return null;
  }

  return response.imagePath;
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

Hooks.on("getSceneControlButtons", (buttonMetaLookup) => {
  registerNpcPortraitSceneControl(buttonMetaLookup);
});

Hooks.once("ready", async () => {
  registerNpcPortraitSceneControlWrapper();

  CONFIG.queries[QUERY_TOGGLE_CHARACTER_PORTRAIT] = async (queryData) => {
    if (!game.user.isGM) return { ok: false, reason: "not-gm" };

    const userId = queryData?.userId;
    if (!userId) return { ok: false, reason: "missing-user-id" };

    const user = game.users.get(userId);
    if (!user) return { ok: false, reason: "user-not-found" };

    const imagePath = getUserCharacterPortraitPath(user);
    if (!imagePath) return { ok: false, reason: "missing-portrait" };

    await toggleImageToAllAsGm(imagePath);

    return {
      ok: true,
      imagePath
    };
  };

  game.socket.on(SOCKET_NAME, handleSocketMessage);

  globalThis.NpcPortraitOverlay = {
    resolveFolderImages,
    showImages,
    setImagesToAll,
    addImageToAll,
    removeImageToAll,
    toggleImageToAll,
    clearAll,
    showFolderToAll,
    pickAndAddImage,
    restoreFromState,
    forceRemoveLocalOverlay,
    openImageBrowser: openNpcImageBrowser,
    getUserCharacterPortraitPath,
    toggleMyCharacterInOverlay
  };

  log("API ready", globalThis.NpcPortraitOverlay);

  window.addEventListener("resize", onWindowResize);

  scheduleRestoreFromState({ resetAttempts: true });
});