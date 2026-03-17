/* -------------------------------------------------------------------------- */
/*  Image Browser (Foundry VTT v13, ApplicationV2)                            */
/* -------------------------------------------------------------------------- */
/*  Goals (MVP):                                                              */
/*  - Browse a folder (data source) and show thumbnails                       */
/*  - Zoom slider adjusts square cell size                                    */
/*  - Click selects an image                                                  */
/*  - Double-click adds to NPC Portrait Overlay via addImageToAll(imagePath)  */
/*  - Folder favorites on the left (client setting)                           */
/* -------------------------------------------------------------------------- */


/* ========================================================================== */
/*  BLOCK 01. MODULE CONSTANTS                                                */
/* ========================================================================== */

const MODULE_ID = "npc-portrait-overlay";

const SETTINGS = {
  FAVORITE_FOLDERS: "imageBrowser.favoriteFolders",
  LAST_FOLDER: "imageBrowser.lastFolder",
  ZOOM: "imageBrowser.zoom"
};

const DEFAULTS = {
  lastFolder: "images",
  zoom: 200
};

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"];

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;


/* ========================================================================== */
/*  BLOCK 02. BASIC HELPERS                                                   */
/* ========================================================================== */

function isImageFile(path) {
  const lower = String(path).toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function ensureNpcOverlayApi() {
  return globalThis.NpcPortraitOverlay && typeof globalThis.NpcPortraitOverlay.addImageToAll === "function";
}

function getNpcOverlayApi() {
  return globalThis.NpcPortraitOverlay;
}

function getSetting(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (_) {
    return fallback;
  }
}

async function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

async function browseFolder(folderPath) {
  const result = await FilePicker.browse("data", folderPath);
  const files = (result?.files ?? []).filter(isImageFile).sort((a, b) => a.localeCompare(b));
  return files;
}

function normalizeFolderPath(path) {
  const p = String(path ?? "").trim();
  if (!p) return DEFAULTS.lastFolder;
  return p.replace(/\\/g, "/");
}

function uniqueArray(items) {
  return [...new Set(items)];
}

function removeFromArray(items, value) {
  return items.filter(x => x !== value);
}

function getCopyableImagePath(path) {
  const normalized = String(path ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "";

  const dataMarkerMatch = normalized.match(/\/Data\/(.*)$/i);
  if (dataMarkerMatch?.[1]) return dataMarkerMatch[1];

  const lower = normalized.toLowerCase();
  const dataPrefix = "data/";
  if (lower.startsWith(dataPrefix)) {
    return normalized.slice(dataPrefix.length);
  }

  return normalized.replace(/^\/+/, "");
}

async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return false;

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  textArea.style.left = "-1000px";
  document.body.appendChild(textArea);
  textArea.select();

  let success = false;
  try {
    success = document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }

  return success;
}

/* ========================================================================== */
/*  BLOCK 03. IMAGE GROUPING HELPER                                           */
/* ========================================================================== */

function buildImageSections(imagePaths) {
  const groups = new Map();

  const getFileStem = (path) => {
    const file = path.split("/").pop() ?? "";
    return file.replace(/\.[^/.]+$/, "");
  };

  const toTitle = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  const isPureNumber = (s) => /^\d+$/.test(s);

  const parseTrailingNumber = (stem) => {
    const m = stem.match(/-(\d+)$/);
    return m ? Number(m[1]) : null;
  };

  const getTypeKey = (stem) => {
    const parts = stem.split("-");
    if (parts.length < 2) return null;
    const second = parts[1];
    if (!second || isPureNumber(second)) return null;
    return parts.length >= 3 ? second.toLowerCase() : null;
  };

  const isNamedSingle = (stem) => {
    const parts = stem.split("-");
    if (parts.length !== 2) return false;
    return !isPureNumber(parts[1]);
  };

  for (const path of imagePaths) {
    const stem = getFileStem(path);
    const parts = stem.split("-");
    const species = (parts[0] ?? "other").toLowerCase();

    if (!groups.has(species)) {
      groups.set(species, {
        named: [],
        typed: new Map(),
        plain: []
      });
    }

    const group = groups.get(species);

    if (parts.length === 1) {
      group.named.push({ path, stem });
      continue;
    }

    if (parts.length === 2 && isPureNumber(parts[1])) {
      group.plain.push({ path, stem, num: Number(parts[1]) });
      continue;
    }

    if (isNamedSingle(stem)) {
      group.named.push({ path, stem });
      continue;
    }

    const type = getTypeKey(stem) ?? "other";
    const num = parseTrailingNumber(stem);

    if (!group.typed.has(type)) group.typed.set(type, []);
    group.typed.get(type).push({ path, stem, num });
  }

  const sortByNumThenStem = (a, b) => {
    const an = a.num;
    const bn = b.num;
    if (an != null && bn != null && an !== bn) return an - bn;
    if (an != null && bn == null) return -1;
    if (an == null && bn != null) return 1;
    return a.stem.localeCompare(b.stem);
  };

  const sections = [];
  const speciesKeys = [...groups.keys()].sort();

  for (const species of speciesKeys) {
    const group = groups.get(species);

    group.named.sort((a, b) => a.stem.localeCompare(b.stem));
    group.plain.sort(sortByNumThenStem);

    const typedAll = [];
    const typeKeys = [...group.typed.keys()].sort();
    for (const type of typeKeys) {
      const arr = group.typed.get(type);
      arr.sort(sortByNumThenStem);
      for (const item of arr) typedAll.push(item);
    }

    const images = [
      ...group.named.map(({ path, stem }) => ({ path, name: stem })),
      ...typedAll.map(({ path, stem }) => ({ path, name: stem })),
      ...group.plain.map(({ path, stem }) => ({ path, name: stem }))
    ];

    sections.push({
      title: toTitle(species),
      images
    });
  }

  return sections;
}


/* ========================================================================== */
/*  BLOCK 04. APPLICATION CLASS SHELL                                         */
/* ========================================================================== */

class NpcImageBrowserApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /* ------------------------------------------------------------------------ */
  /*  04A. STATIC OPTIONS                                                     */
  /* ------------------------------------------------------------------------ */

  static DEFAULT_OPTIONS = {
    id: "npc-image-browser",
    tag: "section",
    classes: ["npc-image-browser"],
    window: {
      title: "Image Browser",
      resizable: true
    },
    position: {
      width: 1080,
      height: 720
    }
  };

  static PARTS = {
    main: {
      template: "modules/npc-portrait-overlay/templates/image-browser.hbs"
    }
  };

  /* ------------------------------------------------------------------------ */
  /*  04B. CONSTRUCTOR                                                        */
  /* ------------------------------------------------------------------------ */

  constructor(options = {}) {
    super(options);

    this._model = {
      currentFolder: normalizeFolderPath(getSetting(SETTINGS.LAST_FOLDER, DEFAULTS.lastFolder)),
      zoom: Number(getSetting(SETTINGS.ZOOM, DEFAULTS.zoom)) || DEFAULTS.zoom,
      search: "",
      selectedImagePath: null,
      images: [],
      favoritesFolders: getSetting(SETTINGS.FAVORITE_FOLDERS, []),
      isLoading: false
    };
  }

  /* ------------------------------------------------------------------------ */
  /*  04C. LIFECYCLE                                                          */
  /* ------------------------------------------------------------------------ */

  async _preFirstRender() {
    await super._preFirstRender();
    await this._loadFolder(this._model.currentFolder);
  }

  async _prepareContext(_options) {
    const favoritesFolders = Array.isArray(this._model.favoritesFolders) ? this._model.favoritesFolders : [];
    let imagePaths = Array.isArray(this._model.images) ? this._model.images : [];

    const toBaseName = (p) => p.split("/").filter(Boolean).pop() ?? p;

    const favoritesFoldersView = favoritesFolders.map((p) => ({
      path: p,
      name: toBaseName(p)
    }));

    const search = String(this._model.search ?? "").trim().toLowerCase();
    if (search) {
      imagePaths = imagePaths.filter((p) => toBaseName(p).toLowerCase().includes(search));
    }

    const sections = buildImageSections(imagePaths);

    const imagesView = imagePaths.map((p) => ({
      path: p,
      name: toBaseName(p)
    }));

    return {
      currentFolder: this._model.currentFolder,
      zoom: this._model.zoom,
      search: this._model.search,
      isLoading: this._model.isLoading,
      favoritesFolders: favoritesFoldersView,
      selectedImagePath: this._model.selectedImagePath,
      images: imagesView,
      sections,
      npcOverlayAvailable: ensureNpcOverlayApi(),
      tagsPlaceholder: ["human", "goblin", "triton"]
    };
  }

  _onRender(_context, _options) {
    const root = this.element;
    if (!root) return;

    const zoomInput = root.querySelector("[data-action='zoom']");
    const zoomValueEl = root.querySelector("[data-role='zoom-value']");
    const folderInput = root.querySelector("[data-action='folder-input']");
    const searchInput = root.querySelector("[data-action='search']");
    const reloadBtn = root.querySelector("[data-action='reload']");
    const addFavFolderBtn = root.querySelector("[data-action='fav-folder-add']");
    const removeFavFolderBtn = root.querySelector("[data-action='fav-folder-remove']");

    const favoritesList = root.querySelector("[data-role='favorites-folders']");
    const galleryViewport = root.querySelector("[data-role='gallery-viewport']");

    if (zoomInput && !zoomInput.dataset.bound) {
      zoomInput.dataset.bound = "1";
      zoomInput.addEventListener("input", async (ev) => {
        const value = Number(ev.target.value) || DEFAULTS.zoom;
        this._model.zoom = value;
        await setSetting(SETTINGS.ZOOM, value);
        this._applyZoomToGallery();

        if (zoomValueEl) zoomValueEl.textContent = `${value}px`;

        requestAnimationFrame(() => this._applyGalleryViewport());
      });
    }
    if (zoomInput) zoomInput.value = String(this._model.zoom);
    if (zoomValueEl) zoomValueEl.textContent = `${this._model.zoom}px`;

    if (folderInput && !folderInput.dataset.bound) {
      folderInput.dataset.bound = "1";

      folderInput.addEventListener("keydown", async (ev) => {
        if (ev.key !== "Enter") return;
        const nextFolder = normalizeFolderPath(ev.target.value);
        await this._loadFolder(nextFolder);

        requestAnimationFrame(() => this._applyGalleryViewport());
      });
    }
    if (folderInput) folderInput.value = this._model.currentFolder;

    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = "1";

      searchInput.addEventListener("input", (ev) => {
        this._model.search = String(ev.target.value ?? "");
        this._applySearchFilter();
      });
    }
    if (searchInput) searchInput.value = this._model.search;

    if (reloadBtn && !reloadBtn.dataset.bound) {
      reloadBtn.dataset.bound = "1";
      reloadBtn.addEventListener("click", async () => {
        await this._loadFolder(this._model.currentFolder);
        requestAnimationFrame(() => this._applyGalleryViewport());
      });
    }

    if (addFavFolderBtn && !addFavFolderBtn.dataset.bound) {
      addFavFolderBtn.dataset.bound = "1";
      addFavFolderBtn.addEventListener("click", async () => {
        await this._addCurrentFolderToFavorites();
      });
    }

    if (removeFavFolderBtn && !removeFavFolderBtn.dataset.bound) {
      removeFavFolderBtn.dataset.bound = "1";
      removeFavFolderBtn.addEventListener("click", async () => {
        await this._removeCurrentFolderFromFavorites();
      });
    }

    if (favoritesList && !favoritesList.dataset.bound) {
      favoritesList.dataset.bound = "1";
      favoritesList.addEventListener("click", async (ev) => {
        const el = ev.target.closest("[data-folder]");
        if (!el) return;
        const folder = el.getAttribute("data-folder");
        if (!folder) return;

        await this._loadFolder(folder);
        requestAnimationFrame(() => this._applyGalleryViewport());
      });
    }

    if (galleryViewport && !galleryViewport.dataset.bound) {
      galleryViewport.dataset.bound = "1";

      galleryViewport.addEventListener("click", async (ev) => {
        const copyBtn = ev.target.closest("[data-action='copy-path']");
        if (copyBtn) {
          ev.preventDefault();
          ev.stopPropagation();

          const card = copyBtn.closest("[data-image]");
          const imagePath = card?.getAttribute("data-image");
          if (!imagePath) return;

          await this._copyImagePath(imagePath);
          return;
        }

        const card = ev.target.closest("[data-image]");
        if (!card) return;

        const imagePath = card.getAttribute("data-image");
        if (!imagePath) return;

        const overlaySet = this._getOverlayImageSet();

        if (overlaySet.has(imagePath)) {
          await globalThis.NpcPortraitOverlay.removeImageToAll(imagePath);
        } else {
          await globalThis.NpcPortraitOverlay.addImageToAll(imagePath);
        }

        this._updateOverlayHighlights();
      });

      galleryViewport.addEventListener("dblclick", (ev) => {
        const card = ev.target.closest("[data-image]");
        if (!card) return;
        ev.preventDefault();
      });
    }

    this._applyZoomToGallery();
    this._updateSelectionHighlight();
    this._applySearchFilter();
    this._updateOverlayHighlights();

    requestAnimationFrame(() => this._applyGalleryViewport());
  }

  /* ------------------------------------------------------------------------ */
  /*  04D. VIEW / DOM HELPERS                                                 */
  /* ------------------------------------------------------------------------ */

  _applyGalleryViewport() {
    const root = this.element;
    if (!root) return;

    const right = root.querySelector(".npcib-right");
    const toolbar = root.querySelector(".npcib-toolbar");
    const viewport = root.querySelector("[data-role='gallery-viewport']");
    if (!right || !toolbar || !viewport) return;

    const rightHeight = right.clientHeight;
    const toolbarHeight = toolbar.offsetHeight;

    if (!rightHeight || !toolbarHeight) {
      requestAnimationFrame(() => this._applyGalleryViewport());
      return;
    }

    const available = Math.max(120, Math.floor(rightHeight - toolbarHeight));

    viewport.style.height = `${available}px`;
    viewport.style.overflowY = "auto";
    viewport.style.overflowX = "hidden";
  }

  _applyZoomToGallery() {
    const root = this.element;
    if (!root) return;

    const galleries = root.querySelectorAll("[data-role='gallery']");
    if (!galleries.length) return;

    for (const gallery of galleries) {
      gallery.style.setProperty("--cell-size", `${this._model.zoom}px`);
    }
  }

  _applySearchFilter() {
    const root = this.element;
    if (!root) return;

    const term = String(this._model.search ?? "").trim().toLowerCase();
    const cards = root.querySelectorAll("[data-image]");

    for (const el of cards) {
      const fullPath = el.getAttribute("data-image") ?? "";
      const name = fullPath.split("/").filter(Boolean).pop() ?? fullPath;
      const haystack = (name + " " + fullPath).toLowerCase();

      const visible = !term || haystack.includes(term);
      el.style.display = visible ? "" : "none";
    }
  }

  _updateSelectionHighlight() {
    const root = this.element;
    if (!root) return;

    const selected = this._model.selectedImagePath;
    root.querySelectorAll("[data-image]").forEach((el) => {
      const path = el.getAttribute("data-image");
      el.classList.toggle("is-selected", Boolean(selected && path === selected));
    });
  }

  async _copyImagePath(imagePath) {
    const copyPath = getCopyableImagePath(imagePath);

    if (!copyPath) {
      ui.notifications.warn("Could not determine the image path to copy.");
      return;
    }

    try {
      const ok = await copyTextToClipboard(copyPath);

      if (!ok) {
        ui.notifications.warn("Could not copy the image path.");
        return;
      }

      ui.notifications.info(`Copied: ${copyPath}`);
    } catch (error) {
      console.error(error);
      ui.notifications.error("Failed to copy the image path.");
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  04E. DATA / MODEL ACTIONS                                               */
  /* ------------------------------------------------------------------------ */

  async _loadFolder(folderPath) {
    const nextFolder = normalizeFolderPath(folderPath);

    this._model.isLoading = true;
    this.render({ force: true });

    try {
      const files = await browseFolder(nextFolder);

      this._model.currentFolder = nextFolder;
      this._model.images = files;
      this._model.selectedImagePath = files[0] ?? null;

      await setSetting(SETTINGS.LAST_FOLDER, nextFolder);
    } catch (error) {
      console.error(error);
      ui.notifications.error(`Could not browse folder: ${nextFolder}`);
    } finally {
      this._model.isLoading = false;
      this.render({ force: true });
    }

    this._updateOverlayHighlights();
  }

  async _addCurrentFolderToFavorites() {
    const current = this._model.currentFolder;
    const favorites = Array.isArray(this._model.favoritesFolders) ? this._model.favoritesFolders : [];
    const next = uniqueArray([...favorites, current]).sort((a, b) => a.localeCompare(b));

    this._model.favoritesFolders = next;
    await setSetting(SETTINGS.FAVORITE_FOLDERS, next);
    this.render({ force: true });
  }

  async _removeCurrentFolderFromFavorites() {
    const current = this._model.currentFolder;
    const favorites = Array.isArray(this._model.favoritesFolders) ? this._model.favoritesFolders : [];
    const next = removeFromArray(favorites, current);

    this._model.favoritesFolders = next;
    await setSetting(SETTINGS.FAVORITE_FOLDERS, next);
    this.render({ force: true });
  }

  async _addSelectedToNpcOverlay(imagePath) {
    if (!ensureNpcOverlayApi()) {
      ui.notifications.warn("NPC Portrait Overlay API not available.");
      return;
    }

    const api = getNpcOverlayApi();
    try {
      await api.addImageToAll(imagePath);
    } catch (error) {
      console.error(error);
      ui.notifications.error("Failed to add image to NPC overlay.");
    }
  }

  _getOverlayImageSet() {
    const state = game.settings.get("npc-portrait-overlay", "overlayState");
    const paths = Array.isArray(state?.imagePaths) ? state.imagePaths : [];
    return new Set(paths);
  }

  _updateOverlayHighlights() {
    const root = this.element;
    if (!root) return;

    const overlaySet = this._getOverlayImageSet();
    const cards = root.querySelectorAll("[data-image]");

    for (const card of cards) {
      const path = card.getAttribute("data-image");
      const isInOverlay = path && overlaySet.has(path);
      card.classList.toggle("is-selected", Boolean(isInOverlay));
    }
  }
}


/* ========================================================================== */
/*  BLOCK 05. SINGLETON AND OPEN FUNCTION                                     */
/* ========================================================================== */

let singletonApp = null;

export function openNpcImageBrowser() {
  if (!game.user.isGM) {
    ui.notifications.warn("Only the GM can open the Image Browser.");
    return;
  }

  if (!singletonApp) singletonApp = new NpcImageBrowserApp();
  singletonApp.render({ force: true });
}


/* ========================================================================== */
/*  BLOCK 06. SETTINGS REGISTRATION                                           */
/* ========================================================================== */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.FAVORITE_FOLDERS, {
    name: "Favorite Folders",
    scope: "client",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, SETTINGS.LAST_FOLDER, {
    name: "Last Folder",
    scope: "client",
    config: false,
    type: String,
    default: DEFAULTS.lastFolder
  });

  game.settings.register(MODULE_ID, SETTINGS.ZOOM, {
    name: "Zoom",
    scope: "client",
    config: false,
    type: Number,
    default: DEFAULTS.zoom
  });
});
