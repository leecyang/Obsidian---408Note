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
