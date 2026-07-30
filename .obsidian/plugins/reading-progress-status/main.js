"use strict";

const { MarkdownView, Plugin } = require("obsidian");

module.exports = class ReadingProgressStatusPlugin extends Plugin {
  onload() {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.classList.add("reading-progress-status");
    this.statusBarEl.setAttribute("aria-label", "当前笔记阅读进度");
    this.hideStatus();

    this.scrollEl = null;
    this.boundView = null;
    this.scrollHandler = () => this.scheduleProgressUpdate();
    this.contentLoadHandler = () => this.scheduleProgressUpdate();
    this.bindFrame = 0;
    this.updateFrame = 0;
    this.retryTimers = new Set();
    this.mutationObserver = null;
    this.resizeObserver = null;

    const requestRebind = () => this.scheduleRebind();

    this.registerEvent(this.app.workspace.on("active-leaf-change", requestRebind));
    this.registerEvent(this.app.workspace.on("layout-change", requestRebind));
    this.registerEvent(this.app.workspace.on("file-open", requestRebind));
    this.registerDomEvent(window, "resize", () => this.scheduleProgressUpdate());

    this.app.workspace.onLayoutReady(() => {
      this.scheduleRebind();
    });
  }

  onunload() {
    this.detachFromReadingView();

    if (this.bindFrame) {
      window.cancelAnimationFrame(this.bindFrame);
      this.bindFrame = 0;
    }
    if (this.updateFrame) {
      window.cancelAnimationFrame(this.updateFrame);
      this.updateFrame = 0;
    }

    for (const timer of this.retryTimers) {
      window.clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  scheduleRebind() {
    if (this.bindFrame) {
      window.cancelAnimationFrame(this.bindFrame);
    }

    this.bindFrame = window.requestAnimationFrame(() => {
      this.bindFrame = 0;
      this.bindToActiveReadingView();
    });

    // Reading view DOM can be created shortly after a mode or file switch.
    this.scheduleRetry(80);
    this.scheduleRetry(260);
  }

  scheduleRetry(delay) {
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(timer);
      this.bindToActiveReadingView();
    }, delay);
    this.retryTimers.add(timer);
  }

  bindToActiveReadingView() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (!view || view.getMode() !== "preview") {
      this.detachFromReadingView();
      this.hideStatus();
      return;
    }

    const nextScrollEl = this.findReadingScrollElement(view);
    if (!nextScrollEl) {
      this.detachFromReadingView();
      this.hideStatus();
      return;
    }

    if (this.boundView === view && this.scrollEl === nextScrollEl) {
      this.scheduleProgressUpdate();
      return;
    }

    this.detachFromReadingView();
    this.boundView = view;
    this.scrollEl = nextScrollEl;

    this.scrollEl.addEventListener("scroll", this.scrollHandler, { passive: true });
    this.scrollEl.addEventListener("load", this.contentLoadHandler, true);

    this.mutationObserver = new MutationObserver(() => this.scheduleProgressUpdate());
    this.mutationObserver.observe(this.scrollEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "open"]
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.scheduleProgressUpdate());
      this.resizeObserver.observe(this.scrollEl);

      const renderedContent = this.scrollEl.querySelector(".markdown-preview-sizer");
      if (renderedContent) {
        this.resizeObserver.observe(renderedContent);
      }
    }

    this.showStatus();
    this.scheduleProgressUpdate();
  }

  findReadingScrollElement(view) {
    const preview = view.containerEl.querySelector(".markdown-preview-view");
    const readingView = view.containerEl.querySelector(".markdown-reading-view");
    const viewContent = view.containerEl.querySelector(".view-content");

    const candidates = [preview, readingView, viewContent].filter(
      (element) => element instanceof HTMLElement
    );

    for (const candidate of candidates) {
      const overflowY = window.getComputedStyle(candidate).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return candidate;
      }
    }

    return candidates[0] ?? null;
  }

  detachFromReadingView() {
    if (this.scrollEl) {
      this.scrollEl.removeEventListener("scroll", this.scrollHandler);
      this.scrollEl.removeEventListener("load", this.contentLoadHandler, true);
    }

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.scrollEl = null;
    this.boundView = null;
  }

  scheduleProgressUpdate() {
    if (this.updateFrame) {
      return;
    }

    this.updateFrame = window.requestAnimationFrame(() => {
      this.updateFrame = 0;
      this.updateProgress();
    });
  }

  updateProgress() {
    if (!this.scrollEl || !this.scrollEl.isConnected) {
      this.scheduleRebind();
      return;
    }

    const scrollTop = Math.max(0, this.scrollEl.scrollTop);
    const scrollHeight = this.scrollEl.scrollHeight;
    const clientHeight = this.scrollEl.clientHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);

    let progress;
    if (maxScroll <= 1) {
      // The entire note is already visible in the viewport.
      progress = 100;
    } else if (scrollTop + clientHeight >= scrollHeight - 1) {
      progress = 100;
    } else {
      progress = Math.round((scrollTop / maxScroll) * 100);
    }

    progress = Math.min(100, Math.max(0, progress));
    const label = `${progress}%`;

    if (this.statusBarEl.textContent !== label) {
      this.statusBarEl.textContent = label;
    }
    this.statusBarEl.setAttribute("aria-label", `当前笔记阅读进度：${label}`);
    this.statusBarEl.setAttribute("title", `当前笔记阅读进度：${label}`);
    this.showStatus();
  }

  showStatus() {
    this.statusBarEl.style.display = "";
  }

  hideStatus() {
    this.statusBarEl.style.display = "none";
    this.statusBarEl.textContent = "";
  }
};
