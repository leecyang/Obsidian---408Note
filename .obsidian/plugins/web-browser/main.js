/*
 * Web Browser for Obsidian — local compatibility build
 *
 * Fixes for modern Obsidian / Electron:
 * - removes the deleted electron.remote API
 * - removes the deleted <webview> new-window event
 * - avoids private headerEl/contentEl child indexes
 * - adds stable command/ribbon entry points and an in-view toolbar
 */

const {
  Plugin,
  ItemView,
  FileView,
  Notice,
  FileSystemAdapter,
  setIcon,
} = require("obsidian");
const path = require("path");
const { pathToFileURL } = require("url");

const WEB_BROWSER_VIEW_ID = "web-browser-view";
const WEB_BROWSER_FILE_VIEW_ID = "web-browser-file-view";
const HTML_FILE_EXTENSIONS = ["html", "htm"];
const DEFAULT_URL = "https://cn.bing.com";
const HOVER_PREVIEW_DELAY = 450;
const HOVER_PREVIEW_CLOSE_DELAY = 220;
const HOVER_PREVIEW_ZOOM_FACTOR = 0.67;

function normalizeInput(rawInput) {
  const input = String(rawInput ?? "").trim();
  if (!input) return DEFAULT_URL;

  // Preserve supported schemes.
  if (/^(https?:\/\/|file:\/\/|about:|data:)/i.test(input)) {
    return input;
  }

  // Local development addresses normally use HTTP.
  if (/^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(input)) {
    return `http://${input}`;
  }

  // IPv4 / private-network host with optional port and path.
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(input)) {
    return `http://${input}`;
  }

  // Domain name with optional port/path/query/hash.
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(input)) {
    return `https://${input}`;
  }

  return `https://cn.bing.com/search?q=${encodeURIComponent(input)}`;
}

function createIconButton(parent, icon, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "web-browser-toolbar-button clickable-icon";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  parent.appendChild(button);
  return button;
}

async function openBrowserView(app, newLeaf = true, state = {}) {
  const leaf = app.workspace.getLeaf(newLeaf ? "tab" : false);
  await leaf.setViewState({
    type: WEB_BROWSER_VIEW_ID,
    active: true,
    state: { url: state.url || DEFAULT_URL },
  });
  app.workspace.revealLeaf(leaf);
}

class WebBrowserView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentUrl = DEFAULT_URL;
    this.currentTitle = "网页浏览器";
    this.frame = null;
    this.isWebview = false;
    this.pendingUrl = null;
    this.webviewReady = false;
  }

  getViewType() {
    return WEB_BROWSER_VIEW_ID;
  }

  getDisplayText() {
    return this.currentTitle || "网页浏览器";
  }

  getIcon() {
    return "globe-2";
  }

  async onOpen() {
    this.contentEl.replaceChildren();
    this.contentEl.classList.add("web-browser-view-content");

    const root = document.createElement("div");
    root.className = "web-browser-root";
    this.contentEl.appendChild(root);

    const toolbar = document.createElement("div");
    toolbar.className = "web-browser-toolbar";
    root.appendChild(toolbar);

    this.backButton = createIconButton(toolbar, "arrow-left", "后退", () => this.goBack());
    this.forwardButton = createIconButton(toolbar, "arrow-right", "前进", () => this.goForward());
    this.reloadButton = createIconButton(toolbar, "rotate-cw", "刷新", () => this.reload());
    createIconButton(toolbar, "home", "主页", () => this.navigate(DEFAULT_URL));

    this.addressInput = document.createElement("input");
    this.addressInput.type = "text";
    this.addressInput.className = "web-browser-search-bar";
    this.addressInput.placeholder = "使用必应搜索或输入网址";
    this.addressInput.spellcheck = false;
    this.addressInput.autocomplete = "off";
    this.addressInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.navigate(this.addressInput.value);
      }
    });
    toolbar.appendChild(this.addressInput);

    createIconButton(toolbar, "external-link", "在系统浏览器中打开", () => {
      this.plugin.openExternal(this.currentUrl);
    });

    const browserHost = document.createElement("div");
    browserHost.className = "web-browser-host";
    root.appendChild(browserHost);

    this.createBrowserFrame(browserHost);
    this.updateNavigationButtons();

    const initialUrl = this.pendingUrl || this.currentUrl || DEFAULT_URL;
    this.pendingUrl = null;
    this.navigate(initialUrl, false);
  }

  async onClose() {
    if (this.frame && this.isWebview && this.webviewReady) {
      try {
        this.frame.stop();
      } catch (_) {}
    }
    this.webviewReady = false;
    this.frame = null;
  }

  async setState(state, result) {
    const url = state && typeof state.url === "string" ? state.url : DEFAULT_URL;
    this.currentUrl = url;
    if (this.frame) {
      this.navigate(url, false);
    } else {
      this.pendingUrl = url;
    }
  }

  getState() {
    return { url: this.currentUrl || DEFAULT_URL };
  }

  createBrowserFrame(parent) {
    const candidate = document.createElement("webview");
    this.isWebview = typeof candidate.reload === "function" || typeof candidate.getURL === "function";

    if (this.isWebview) {
      this.frame = candidate;
      this.webviewReady = false;
      candidate.className = "web-browser-frame";
      candidate.setAttribute("partition", "persist:obsidian-web-browser");
      candidate.setAttribute("webpreferences", "contextIsolation=yes, nodeIntegration=no, sandbox=yes");
      // Register lifecycle listeners before attaching the custom element.
      this.registerWebviewEvents(candidate);
      parent.appendChild(candidate);
      return;
    }

    // Fallback for builds where Electron's webviewTag is disabled.
    const iframe = document.createElement("iframe");
    iframe.className = "web-browser-frame web-browser-iframe-fallback";
    iframe.setAttribute(
      "sandbox",
      "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads"
    );
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.addEventListener("load", () => this.updateNavigationButtons());
    parent.appendChild(iframe);
    this.frame = iframe;

    const warning = document.createElement("div");
    warning.className = "web-browser-fallback-notice";
    warning.textContent = "当前 Obsidian 构建未启用 Electron webview；部分禁止 iframe 嵌入的网站无法显示，可使用右上角按钮在系统浏览器打开。";
    parent.appendChild(warning);
  }

  registerWebviewEvents(webview) {
    const syncUrl = (url) => {
      if (!url) return;
      this.currentUrl = url;
      if (this.addressInput) this.addressInput.value = url;
      this.updateNavigationButtons();
      this.app.workspace.requestSaveLayout();
    };

    webview.addEventListener("did-navigate", (event) => syncUrl(event.url));
    webview.addEventListener("did-navigate-in-page", (event) => syncUrl(event.url));
    webview.addEventListener("did-stop-loading", () => {
      try {
        syncUrl(webview.getURL());
      } catch (_) {}
    });

    webview.addEventListener("page-title-updated", (event) => {
      this.currentTitle = event.title || "网页浏览器";
      if (typeof this.leaf.updateHeader === "function") {
        this.leaf.updateHeader();
      }
    });

    webview.addEventListener("did-fail-load", (event) => {
      // -3 means an in-progress navigation was intentionally aborted by another one.
      if (event.isMainFrame !== false && event.errorCode !== -3) {
        new Notice(`网页加载失败：${event.errorDescription || event.errorCode}`);
      }
    });

    webview.addEventListener("dom-ready", () => {
      this.webviewReady = true;

      // setState() may arrive after onOpen() has already started loading the
      // default page. Preserve the most recently requested URL and apply it
      // only now, because Electron webview methods are safe after dom-ready.
      const requestedUrl = this.pendingUrl;
      this.pendingUrl = null;

      let loadedUrl = "";
      try {
        loadedUrl = webview.getURL() || "";
      } catch (_) {}

      this.installSameTabPopupHandler(webview);
      this.updateNavigationButtons();

      if (requestedUrl && requestedUrl !== loadedUrl) {
        this.currentUrl = requestedUrl;
        if (this.addressInput) this.addressInput.value = requestedUrl;
        try {
          const navigation = webview.loadURL(requestedUrl);
          if (navigation && typeof navigation.catch === "function") {
            navigation.catch((error) => {
              new Notice(`无法打开网页：${error && error.message ? error.message : error}`);
            });
          }
        } catch (error) {
          new Notice(`无法打开网页：${error && error.message ? error.message : error}`);
        }
        return;
      }

      syncUrl(loadedUrl);
    });
  }

  installSameTabPopupHandler(webview) {
    // Electron removed the renderer-side <webview> new-window event. Without
    // access to the host main process, keep ordinary target=_blank links in
    // the same embedded tab. This avoids electron.remote entirely.
    const script = `(() => {
      if (window.__obsidianWebBrowserPatched) return;
      window.__obsidianWebBrowserPatched = true;
      document.addEventListener('click', (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const anchor = path.find((node) => node && node.tagName === 'A') ||
          (event.target && event.target.closest ? event.target.closest('a') : null);
        if (!anchor || !anchor.href || anchor.hasAttribute('download')) return;
        if (anchor.target === '_blank') {
          event.preventDefault();
          location.assign(anchor.href);
        }
      }, true);
      const nativeOpen = window.open;
      window.open = function(url, target, features) {
        if (typeof url === 'string' && url && url !== 'about:blank') {
          location.assign(url);
          return null;
        }
        return nativeOpen.call(window, url, target, features);
      };
    })();`;

    try {
      const result = webview.executeJavaScript(script, true);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  }

  navigate(rawUrl, saveLayout = true) {
    const url = normalizeInput(rawUrl);
    this.currentUrl = url;
    if (this.addressInput) this.addressInput.value = url;

    if (!this.frame) {
      this.pendingUrl = url;
      return;
    }

    try {
      if (this.isWebview) {
        if (!this.webviewReady) {
          // A view can receive setState() while its default page is still
          // attaching. Keep only the newest requested URL. If no navigation
          // has started yet, src performs the initial declarative load;
          // otherwise dom-ready will apply the pending URL with loadURL().
          this.pendingUrl = url;
          if (!this.frame.getAttribute("src")) {
            this.frame.setAttribute("src", url);
          }
        } else {
          this.pendingUrl = null;
          let loadedUrl = "";
          try {
            loadedUrl = this.frame.getURL() || "";
          } catch (_) {}
          if (loadedUrl !== url) {
            const navigation = this.frame.loadURL(url);
            if (navigation && typeof navigation.catch === "function") {
              navigation.catch((error) => {
                new Notice(`无法打开网页：${error && error.message ? error.message : error}`);
              });
            }
          }
        }
      } else {
        this.frame.setAttribute("src", url);
      }
    } catch (error) {
      new Notice(`无法打开网页：${error && error.message ? error.message : error}`);
    }

    if (saveLayout) this.app.workspace.requestSaveLayout();
  }

  goBack() {
    if (!this.isWebview || !this.frame || !this.webviewReady) return;
    try {
      if (this.frame.canGoBack()) this.frame.goBack();
    } catch (_) {}
  }

  goForward() {
    if (!this.isWebview || !this.frame || !this.webviewReady) return;
    try {
      if (this.frame.canGoForward()) this.frame.goForward();
    } catch (_) {}
  }

  reload() {
    if (!this.frame) return;
    try {
      if (this.isWebview && this.webviewReady && typeof this.frame.reload === "function") {
        this.frame.reload();
      } else {
        const url = this.currentUrl;
        this.frame.removeAttribute("src");
        this.frame.setAttribute("src", url);
      }
    } catch (_) {}
  }

  updateNavigationButtons() {
    let canBack = false;
    let canForward = false;
    if (this.isWebview && this.frame && this.webviewReady) {
      try {
        canBack = this.frame.canGoBack();
        canForward = this.frame.canGoForward();
      } catch (_) {}
    }
    if (this.backButton) this.backButton.disabled = !canBack;
    if (this.forwardButton) this.forwardButton.disabled = !canForward;
  }
}


class HoverPreviewManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.popup = null;
    this.frame = null;
    this.isWebview = false;
    this.webviewReady = false;
    this.activeAnchor = null;
    this.pendingAnchor = null;
    this.currentUrl = "";
    this.isPinned = false;
    this.hoverTimer = null;
    this.closeTimer = null;
    this.hideTransitionTimer = null;
    this.positionFrame = null;
  }

  start() {
    this.createPopup();

    this.plugin.registerDomEvent(document, "pointerover", (event) => {
      this.handlePointerOver(event);
    }, true);

    this.plugin.registerDomEvent(document, "pointerout", (event) => {
      this.handlePointerOut(event);
    }, true);

    this.plugin.registerDomEvent(document, "pointerdown", (event) => {
      if (!this.popup || !this.isVisible() || this.isPinned) return;
      const target = event.target;
      if (target instanceof Node && this.popup.contains(target)) return;
      if (target instanceof Node && this.activeAnchor && this.activeAnchor.contains(target)) return;
      this.hidePreview(true);
    }, true);

    this.plugin.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && this.isVisible()) {
        event.preventDefault();
        this.setPinned(false);
        this.hidePreview(true);
      }
    }, true);

    this.plugin.registerDomEvent(window, "resize", () => this.queuePositionUpdate());
    this.plugin.registerDomEvent(document, "scroll", () => this.queuePositionUpdate(), true);
    this.plugin.registerDomEvent(window, "blur", () => {
      if (!this.isPinned) this.scheduleClose(0);
    });
  }

  destroy() {
    this.clearHoverTimer();
    this.clearCloseTimer();
    if (this.hideTransitionTimer !== null) {
      window.clearTimeout(this.hideTransitionTimer);
      this.hideTransitionTimer = null;
    }
    if (this.positionFrame !== null) {
      window.cancelAnimationFrame(this.positionFrame);
      this.positionFrame = null;
    }
    this.removeActiveAnchor();
    if (this.frame && this.isWebview && this.webviewReady) {
      try {
        this.frame.stop();
      } catch (_) {}
    }
    if (this.popup) this.popup.remove();
    this.popup = null;
    this.frame = null;
  }

  createPopup() {
    const popup = document.createElement("div");
    popup.className = "web-browser-hover-preview";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "网页悬停预览");
    popup.setAttribute("aria-hidden", "true");

    const header = document.createElement("div");
    header.className = "web-browser-hover-header";
    popup.appendChild(header);

    const identity = document.createElement("div");
    identity.className = "web-browser-hover-identity";
    header.appendChild(identity);

    const icon = document.createElement("span");
    icon.className = "web-browser-hover-site-icon";
    setIcon(icon, "globe-2");
    identity.appendChild(icon);

    const labels = document.createElement("div");
    labels.className = "web-browser-hover-labels";
    identity.appendChild(labels);

    this.titleEl = document.createElement("div");
    this.titleEl.className = "web-browser-hover-title";
    this.titleEl.textContent = "网页预览";
    labels.appendChild(this.titleEl);

    this.urlEl = document.createElement("div");
    this.urlEl.className = "web-browser-hover-url";
    labels.appendChild(this.urlEl);

    const actions = document.createElement("div");
    actions.className = "web-browser-hover-actions";
    header.appendChild(actions);

    this.pinButton = createIconButton(actions, "pin", "固定预览窗", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setPinned(!this.isPinned);
    });
    this.pinButton.classList.add("web-browser-hover-action");

    const openButton = createIconButton(actions, "panel-top-open", "在 Obsidian 标签页中打开", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.currentUrl) this.plugin.openBrowser(true, { url: this.currentUrl });
      this.setPinned(false);
      this.hidePreview(true);
    });
    openButton.classList.add("web-browser-hover-action");

    const externalButton = createIconButton(actions, "external-link", "在系统浏览器中打开", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.currentUrl) this.plugin.openExternal(this.currentUrl);
    });
    externalButton.classList.add("web-browser-hover-action");

    const closeButton = createIconButton(actions, "x", "关闭预览", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setPinned(false);
      this.hidePreview(true);
    });
    closeButton.classList.add("web-browser-hover-action");

    const body = document.createElement("div");
    body.className = "web-browser-hover-body";
    popup.appendChild(body);

    this.loadingEl = document.createElement("div");
    this.loadingEl.className = "web-browser-hover-loading";
    this.loadingEl.textContent = "正在加载网页…";
    body.appendChild(this.loadingEl);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "web-browser-hover-status";
    this.statusEl.hidden = true;
    body.appendChild(this.statusEl);

    this.createPreviewFrame(body);

    popup.addEventListener("pointerenter", () => this.clearCloseTimer());
    popup.addEventListener("pointerleave", () => {
      if (!this.isPinned) this.scheduleClose(HOVER_PREVIEW_CLOSE_DELAY);
    });

    popup.addEventListener("focusin", () => this.clearCloseTimer());
    popup.addEventListener("focusout", (event) => {
      if (this.isPinned) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !popup.contains(next)) {
        this.scheduleClose(HOVER_PREVIEW_CLOSE_DELAY);
      }
    });

    document.body.appendChild(popup);
    this.popup = popup;
  }

  createPreviewFrame(parent) {
    const candidate = document.createElement("webview");
    this.isWebview = typeof candidate.reload === "function" || typeof candidate.getURL === "function";

    if (this.isWebview) {
      candidate.className = "web-browser-hover-frame";
      candidate.setAttribute("partition", "persist:obsidian-web-browser");
      candidate.setAttribute("webpreferences", "contextIsolation=yes, nodeIntegration=no, sandbox=yes");
      this.registerPreviewWebviewEvents(candidate);
      parent.appendChild(candidate);
      this.frame = candidate;
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.className = "web-browser-hover-frame web-browser-hover-iframe";
    iframe.setAttribute(
      "sandbox",
      "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads"
    );
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.addEventListener("load", () => this.setLoading(false));
    parent.appendChild(iframe);
    this.frame = iframe;

    this.showStatus("当前 Obsidian 未启用 webview；禁止 iframe 嵌入的网站可能无法预览。", false);
  }

  registerPreviewWebviewEvents(webview) {
    webview.addEventListener("did-start-loading", () => this.setLoading(true));
    webview.addEventListener("did-stop-loading", () => this.setLoading(false));
    webview.addEventListener("did-navigate", (event) => this.syncNavigatedUrl(event.url));
    webview.addEventListener("did-navigate-in-page", (event) => this.syncNavigatedUrl(event.url));

    webview.addEventListener("page-title-updated", (event) => {
      if (event.title) {
        this.titleEl.textContent = event.title;
        this.titleEl.setAttribute("title", event.title);
      }
    });

    webview.addEventListener("did-fail-load", (event) => {
      if (event.isMainFrame === false || event.errorCode === -3) return;
      this.setLoading(false);
      this.showStatus(`网页加载失败：${event.errorDescription || event.errorCode}`, true);
    });

    webview.addEventListener("dom-ready", () => {
      this.webviewReady = true;
      this.applyPreviewZoom(webview);
      this.patchPreviewPopupNavigation(webview);
      this.setLoading(false);
    });
  }

  applyPreviewZoom(webview) {
    // Keep hover previews information-dense without changing the zoom level of
    // full browser tabs. Electron webviews provide native page zoom, which
    // preserves pointer coordinates and scrolling behavior.
    try {
      if (typeof webview.setZoomFactor === "function") {
        webview.setZoomFactor(HOVER_PREVIEW_ZOOM_FACTOR);
        return;
      }
    } catch (_) {}

    // Compatibility fallback for Obsidian/Electron builds where setZoomFactor
    // is unavailable but executeJavaScript is still exposed.
    const script = `(() => {
      const zoom = ${HOVER_PREVIEW_ZOOM_FACTOR};
      document.documentElement.style.zoom = String(zoom);
      document.documentElement.style.width = String(100 / zoom) + "%";
      document.documentElement.style.minHeight = String(100 / zoom) + "%";
    })();`;

    try {
      const result = webview.executeJavaScript(script, true);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  }

  patchPreviewPopupNavigation(webview) {
    const script = `(() => {
      if (window.__obsidianHoverPreviewPatched) return;
      window.__obsidianHoverPreviewPatched = true;
      document.addEventListener('click', (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const anchor = path.find((node) => node && node.tagName === 'A') ||
          (event.target && event.target.closest ? event.target.closest('a') : null);
        if (!anchor || !anchor.href || anchor.hasAttribute('download')) return;
        if (anchor.target === '_blank') {
          event.preventDefault();
          location.assign(anchor.href);
        }
      }, true);
      const nativeOpen = window.open;
      window.open = function(url, target, features) {
        if (typeof url === 'string' && url && url !== 'about:blank') {
          location.assign(url);
          return null;
        }
        return nativeOpen.call(window, url, target, features);
      };
    })();`;

    try {
      const result = webview.executeJavaScript(script, true);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  }

  handlePointerOver(event) {
    if (this.isPinned) return;
    const target = this.getPreviewTarget(event.target);
    if (!target) return;

    const { anchor, url } = target;
    const related = event.relatedTarget;
    if (related instanceof Node && anchor.contains(related)) return;

    this.clearCloseTimer();
    if (this.activeAnchor === anchor && this.currentUrl === url && this.isVisible()) return;

    this.pendingAnchor = anchor;
    this.clearHoverTimer();
    const delay = this.isVisible() ? 160 : HOVER_PREVIEW_DELAY;
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      if (this.pendingAnchor === anchor && anchor.isConnected) {
        this.showPreview(anchor, url);
      }
    }, delay);
  }

  handlePointerOut(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!anchor) return;

    const related = event.relatedTarget;
    if (related instanceof Node && anchor.contains(related)) return;

    if (this.pendingAnchor === anchor) {
      this.pendingAnchor = null;
      this.clearHoverTimer();
    }

    if (this.activeAnchor !== anchor || this.isPinned) return;
    if (related instanceof Node && this.popup && this.popup.contains(related)) return;
    this.scheduleClose(HOVER_PREVIEW_CLOSE_DELAY);
  }

  getPreviewTarget(node) {
    if (!(node instanceof Element)) return null;
    const anchor = node.closest("a[href]");
    if (!anchor) return null;

    if (anchor.closest(".web-browser-root, .web-browser-hover-preview")) return null;
    if (!anchor.closest(".markdown-preview-view, .markdown-source-view, .markdown-rendered, .cm-editor")) {
      return null;
    }

    const rawHref = anchor.getAttribute("href") || anchor.href || "";
    let parsed;
    try {
      parsed = new URL(rawHref, window.location.href);
    } catch (_) {
      return null;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { anchor, url: parsed.href };
  }

  showPreview(anchor, url) {
    this.clearCloseTimer();
    this.removeActiveAnchor();
    this.activeAnchor = anchor;
    this.activeAnchor.classList.add("web-browser-hover-link-active");
    this.pendingAnchor = null;

    this.popup.classList.add("is-visible");
    this.popup.setAttribute("aria-hidden", "false");
    this.positionPopup();
    this.loadUrl(url);
  }

  hidePreview(immediate = false) {
    this.clearHoverTimer();
    this.clearCloseTimer();
    this.pendingAnchor = null;
    if (!this.popup) return;

    this.popup.classList.remove("is-visible");
    this.popup.setAttribute("aria-hidden", "true");
    this.removeActiveAnchor();

    if (this.hideTransitionTimer !== null) {
      window.clearTimeout(this.hideTransitionTimer);
      this.hideTransitionTimer = null;
    }

    if (immediate) {
      this.popup.classList.remove("is-pinned");
    }
  }

  loadUrl(url) {
    this.currentUrl = url;
    this.updateIdentityFromUrl(url);
    if (this.isWebview) {
      this.showStatus("", false);
    } else {
      this.showStatus("当前 Obsidian 未启用 webview；禁止 iframe 嵌入的网站可能无法预览。", false);
    }
    this.setLoading(true);

    try {
      if (this.isWebview) {
        let loadedUrl = "";
        if (this.webviewReady) {
          try {
            loadedUrl = this.frame.getURL() || "";
          } catch (_) {}
        }

        if (!this.webviewReady) {
          if (this.frame.getAttribute("src") !== url) this.frame.setAttribute("src", url);
        } else if (loadedUrl !== url) {
          const navigation = this.frame.loadURL(url);
          if (navigation && typeof navigation.catch === "function") {
            navigation.catch((error) => {
              this.setLoading(false);
              this.showStatus(`无法预览网页：${error && error.message ? error.message : error}`, true);
            });
          }
        } else {
          this.setLoading(false);
        }
      } else {
        if (this.frame.getAttribute("src") !== url) {
          this.frame.setAttribute("src", url);
        } else {
          this.setLoading(false);
        }
      }
    } catch (error) {
      this.setLoading(false);
      this.showStatus(`无法预览网页：${error && error.message ? error.message : error}`, true);
    }
  }

  syncNavigatedUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    this.currentUrl = url;
    this.updateIdentityFromUrl(url, false);
  }

  updateIdentityFromUrl(url, resetTitle = true) {
    let host = "网页预览";
    try {
      host = new URL(url).hostname || host;
    } catch (_) {}

    if (resetTitle) {
      this.titleEl.textContent = host;
      this.titleEl.setAttribute("title", host);
    }
    this.urlEl.textContent = url;
    this.urlEl.setAttribute("title", url);
  }

  setPinned(pinned) {
    this.isPinned = Boolean(pinned);
    if (!this.popup || !this.pinButton) return;
    this.popup.classList.toggle("is-pinned", this.isPinned);
    this.pinButton.classList.toggle("is-active", this.isPinned);
    this.pinButton.setAttribute("aria-pressed", String(this.isPinned));
    this.pinButton.setAttribute("title", this.isPinned ? "取消固定预览窗" : "固定预览窗");
    this.pinButton.setAttribute("aria-label", this.isPinned ? "取消固定预览窗" : "固定预览窗");
    if (this.isPinned) this.clearCloseTimer();
  }

  setLoading(loading) {
    if (!this.loadingEl) return;
    this.loadingEl.classList.toggle("is-visible", Boolean(loading));
  }

  showStatus(message, isError) {
    if (!this.statusEl) return;
    const hasMessage = Boolean(message);
    this.statusEl.hidden = !hasMessage;
    this.statusEl.textContent = message || "";
    this.statusEl.classList.toggle("is-error", Boolean(isError));
  }

  positionPopup() {
    if (!this.popup || !this.activeAnchor || !this.activeAnchor.isConnected) return;

    const margin = 12;
    const gap = 10;
    const anchorRect = this.activeAnchor.getBoundingClientRect();
    const popupRect = this.popup.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.left;
    let top = anchorRect.bottom + gap;

    if (left + popupRect.width > viewportWidth - margin) {
      left = viewportWidth - popupRect.width - margin;
    }
    if (left < margin) left = margin;

    if (top + popupRect.height > viewportHeight - margin) {
      top = anchorRect.top - popupRect.height - gap;
    }
    if (top < margin) {
      top = Math.min(viewportHeight - popupRect.height - margin, Math.max(margin, anchorRect.bottom + gap));
    }

    this.popup.style.left = `${Math.round(left)}px`;
    this.popup.style.top = `${Math.round(top)}px`;
  }

  queuePositionUpdate() {
    if (!this.isVisible() || !this.activeAnchor) return;
    if (this.positionFrame !== null) return;
    this.positionFrame = window.requestAnimationFrame(() => {
      this.positionFrame = null;
      if (this.activeAnchor && this.activeAnchor.isConnected) {
        this.positionPopup();
      } else if (!this.isPinned) {
        this.hidePreview(true);
      }
    });
  }

  scheduleClose(delay) {
    if (this.isPinned) return;
    this.clearCloseTimer();
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!this.isPinned) this.hidePreview();
    }, Math.max(0, delay));
  }

  clearHoverTimer() {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  clearCloseTimer() {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  removeActiveAnchor() {
    if (this.activeAnchor) {
      this.activeAnchor.classList.remove("web-browser-hover-link-active");
      this.activeAnchor = null;
    }
  }

  isVisible() {
    return Boolean(this.popup && this.popup.classList.contains("is-visible"));
  }
}

class WebBrowserFileView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return WEB_BROWSER_FILE_VIEW_ID;
  }

  canAcceptExtension(extension) {
    return HTML_FILE_EXTENSIONS.includes(extension.toLowerCase());
  }

  async onLoadFile(file) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) && typeof adapter.getBasePath !== "function") {
      new Notice("当前仓库适配器不支持打开本地 HTML 文件。此功能仅适用于桌面文件系统仓库。");
      return;
    }

    const basePath = adapter.getBasePath();
    const absolutePath = path.join(basePath, file.path);
    const fileUrl = pathToFileURL(absolutePath).href;
    await this.plugin.openBrowser(true, { url: fileUrl });
    this.leaf.detach();
  }
}

class WebBrowserPlugin extends Plugin {
  async onload() {
    this.originalWindowOpen = window.open;

    this.registerView(WEB_BROWSER_VIEW_ID, (leaf) => new WebBrowserView(leaf, this));
    this.registerView(WEB_BROWSER_FILE_VIEW_ID, (leaf) => new WebBrowserFileView(leaf, this));

    try {
      this.registerExtensions(HTML_FILE_EXTENSIONS, WEB_BROWSER_FILE_VIEW_ID);
    } catch (_) {
      new Notice("HTML/HTM 扩展名已被其他插件注册；网页浏览功能仍可通过命令使用。");
    }

    this.addRibbonIcon("globe-2", "打开网页浏览器", () => {
      this.openBrowser(true, { url: DEFAULT_URL });
    });

    this.addCommand({
      id: "open-web-browser",
      name: "打开网页浏览器",
      callback: () => this.openBrowser(true, { url: DEFAULT_URL }),
    });

    this.addCommand({
      id: "open-web-browser-current-tab",
      name: "在当前标签页打开网页浏览器",
      callback: () => this.openBrowser(false, { url: DEFAULT_URL }),
    });

    this.hoverPreview = new HoverPreviewManager(this);
    this.hoverPreview.start();
    this.register(() => {
      if (this.hoverPreview) this.hoverPreview.destroy();
    });

    // Preserve the original plugin behavior for ordinary HTTP(S)/file links,
    // but avoid private Obsidian DOM manipulation.
    const plugin = this;
    const patchedWindowOpen = function (url, target, features) {
      const urlString = url instanceof URL ? url.toString() : typeof url === "string" ? url : "";
      if (/^(https?:\/\/|file:\/\/)/i.test(urlString)) {
        plugin.openBrowser(true, { url: urlString });
        return null;
      }
      return plugin.originalWindowOpen.call(window, url, target, features);
    };
    window.open = patchedWindowOpen;

    this.register(() => {
      if (window.open === patchedWindowOpen) {
        window.open = this.originalWindowOpen;
      }
    });
  }

  onunload() {
    if (this.hoverPreview) this.hoverPreview.destroy();
    this.app.workspace.detachLeavesOfType(WEB_BROWSER_VIEW_ID);
    if (this.originalWindowOpen) window.open = this.originalWindowOpen;
  }

  async openBrowser(newLeaf = true, state = {}) {
    return openBrowserView(this.app, newLeaf, state);
  }

  openExternal(url) {
    if (!url) return;
    try {
      this.originalWindowOpen.call(window, url, "_blank");
    } catch (error) {
      new Notice(`无法调用系统浏览器：${error && error.message ? error.message : error}`);
    }
  }
}

module.exports = { default: WebBrowserPlugin };
