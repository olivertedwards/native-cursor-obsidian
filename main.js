var obsidian = require("obsidian");
var codemirrorState = require("@codemirror/state");
var codemirrorView = require("@codemirror/view");

/*
 * === Helpers ===
 */

function patchWith(obj, methods) {
	var patchers = Object.keys(methods).map(function (key) {
		return patchMethod(obj, key, methods[key]);
	});
	return patchers.length === 1
		? patchers[0]
		: function () {
				patchers.forEach(function (p) {
					p();
				});
			};
}

function patchMethod(obj, key, factory) {
	var original = obj[key];
	var hadOwn = obj.hasOwnProperty(key);
	var base = hadOwn
		? original
		: function () {
				return Object.getPrototypeOf(obj)[key].apply(this, arguments);
			};
	var replacement = factory(base);
	if (original) Object.setPrototypeOf(replacement, original);
	Object.setPrototypeOf(proxy, replacement);
	obj[key] = proxy;
	return unpatch;

	function proxy() {
		if (replacement === base && obj[key] === proxy) unpatch();
		return replacement.apply(this, arguments);
	}
	function unpatch() {
		if (obj[key] === proxy) {
			hadOwn ? (obj[key] = original) : delete obj[key];
		}
		if (replacement !== base) {
			replacement = base;
			Object.setPrototypeOf(proxy, original || Function);
		}
	}
}

/*
 * === Table-cell focus tracking ===
 */

var PRIMARY_BUTTON = 0;
var tableFocusAnnotation = codemirrorState.Annotation.define();

var makePointerDownHandler = function (view) {
	return function (event) {
		if (event.button !== PRIMARY_BUTTON) return;
		if (
			event.composedPath().some(function (el) {
				return el instanceof HTMLElement && el.hasClass("table-wrapper");
			})
		) {
			var scrollDOM = view.scrollDOM;
			scrollDOM.addClass("cm-hasTablePointed");
			scrollDOM.win.addEventListener(
				"pointerup",
				function () {
					scrollDOM.removeClass("cm-hasTablePointed");
				},
				{
					once: true,
				},
			);
		}
	};
};

var tableCellViewPlugin = codemirrorView.ViewPlugin.define(function (view) {
	var info = view.state.field(obsidian.editorInfoField);
	var editor = info.editor;
	var handlers = {};
	var controller = new AbortController();

	if (editor && editor.inTableCell && editor.activeCM === view) {
		handlers.update = function (update) {
			if (update.focusChanged) {
				editor.cm.dispatch({
					annotations: tableFocusAnnotation.of(view.hasFocus),
				});
			}
		};
	}
	if ((editor && editor.cm) === view) {
		view.dom.addEventListener("pointerdown", makePointerDownHandler(view), {
			capture: true,
			signal: controller.signal,
		});
		handlers.destroy = function () {
			controller.abort();
		};
	}
	return handlers;
});

/*
 * === Coordinate helper ===
 */

function lineHeightAt(view, pos) {
	try {
		var node = view.domAtPos(pos).node;
		if (node.nodeType === 3) node = node.parentElement;
		var lineEl = node.closest('.cm-line') || node;
		var h = parseFloat(getComputedStyle(lineEl).lineHeight);
		if (h > 0) return h;
	} catch (e) {}
	return view.defaultLineHeight;
}

function getScrollOrigin(view) {
	var rect = view.scrollDOM.getBoundingClientRect();
	var left =
		view.textDirection === codemirrorView.Direction.LTR
			? rect.left
			: rect.right - view.scrollDOM.clientWidth * view.scaleX;
	return {
		top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
		left: left - view.scrollDOM.scrollLeft * view.scaleX,
	};
}

/*
 * === Cursor widget ===
 */

var CursorWidget = (function () {
	function CursorWidget(className, left, top, height) {
		this.className = className;
		this.left = Math.round(left);
		this.top = Math.round(top);
		this.height = Math.round(height);

		var self = this;
		this.adjust = function (el) {
			requestAnimationFrame(function () {
				el.setCssStyles({
					left: self.left + "px",
					top: self.top + "px",
					height: self.height + "px",
				});
			});
		};
		this.requestAdjust = obsidian.debounce(
			function (adjustFn, el) {
				adjustFn(el);
			},
			10,
			false,
		);
	}

	CursorWidget.prototype.draw = function () {
		var el = createDiv(this.className);
		this.adjust(el);
		return el;
	};

	CursorWidget.prototype.update = function (el, prev) {
		if (prev.className !== this.className) return false;
		var nextRequestAdjust =
			prev.requestAdjust != null ? prev.requestAdjust : this.requestAdjust;
		this.requestAdjust = nextRequestAdjust;
		this.requestAdjust(this.adjust, el);
		return true;
	};

	CursorWidget.prototype.eq = function (other) {
		return (
			this.left === other.left &&
			this.top === other.top &&
			this.height === other.height &&
			this.className === other.className
		);
	};

	CursorWidget.forRange = function (view, className, range) {
		var coords = view.coordsAtPos(range.head, range.assoc || 1);
		if (!coords) return null;
		var origin = getScrollOrigin(view);
		var lineHeight = lineHeightAt(view, range.head);
		var glyphTop = coords.top - origin.top;
		var glyphHeight = coords.bottom - coords.top;
		var leading = lineHeight - glyphHeight;
		var top = glyphTop - Math.max(0, leading) / 2;
		var height = Math.max(lineHeight, glyphHeight);
		return new CursorWidget(
			className,
			coords.left - origin.left,
			top,
			height,
		);
	};

	CursorWidget.forTableCellRange = function (
		hostView,
		activeView,
		className,
		range,
	) {
		var coords = activeView.coordsAtPos(range.head, range.assoc || 1);
		if (!coords) return null;
		var origin = getScrollOrigin(hostView);
		var lineHeight = lineHeightAt(activeView, range.head);
		var glyphTop = coords.top - origin.top;
		var glyphHeight = coords.bottom - coords.top;
		var leading = lineHeight - glyphHeight;
		var top = glyphTop - Math.max(0, leading) / 2;
		var height = Math.max(lineHeight, glyphHeight);
		return new CursorWidget(
			className,
			coords.left - origin.left,
			top,
			height,
		);
	};

	return CursorWidget;
})();

/*
 * === Layer update ===
 */

var triggerBlink = obsidian.debounce(
	function (layerDOM) {
		layerDOM.addClass("cm-blinkLayer");
	},
	350,
	true,
);

function getTableActiveCM(state) {
	var info = state.field(obsidian.editorInfoField);
	var editor = info ? info.editor : null;
	if (editor && editor.inTableCell) return editor.activeCM;
	return null;
}

var layerUpdate = function (update, layerDOM) {
	if (
		!update.docChanged &&
		!update.selectionSet &&
		update.transactions.some(function (tr) {
			return !!tr.annotation(tableFocusAnnotation);
		})
	) {
		return false;
	}
	var tableActive = getTableActiveCM(update.state);
	if (tableActive === update.view) return false;
	var isOverTable =
		!update.view.hasFocus && !!(tableActive && tableActive.hasFocus);
	layerDOM.toggleClass("cm-overTableCell", isOverTable);
	if (
		(update.docChanged || update.selectionSet) &&
		(update.view.hasFocus || isOverTable)
	) {
		layerDOM.removeClass("cm-blinkLayer");
		triggerBlink(layerDOM);
		return true;
	}
	return false;
};

var makeMarkersGetter = function () {
	return function (view) {
		var state = view.state;
		var tableActive = null;
		var markers = [];
		if (!view.hasFocus) tableActive = getTableActiveCM(state);
		if (tableActive) state = tableActive.state;
		if (view === tableActive) return markers;

		for (var i = 0; i < state.selection.ranges.length; i++) {
			var range = state.selection.ranges[i];
			var isPrimary = range === state.selection.main;
			var className =
				"cm-cursor " +
				(isPrimary ? "cm-cursor-primary" : "cm-cursor-secondary");
			var widget = tableActive
				? CursorWidget.forTableCellRange(view, tableActive, className, range)
				: CursorWidget.forRange(view, className, range);
			if (widget) markers.push(widget);
		}
		return markers;
	};
};

/*
 * === Internal cursor layer plugin hunter (identical fingerprint check) ===
 */

function isLayerSpec(spec) {
	return (
		spec &&
		"above" in spec &&
		typeof spec.above === "boolean" &&
		"update" in spec &&
		typeof spec.update === "function" &&
		"markers" in spec &&
		typeof spec.markers === "function"
	);
}

function isMeasureReq(req) {
	return req && "read" in req && typeof req.read === "function";
}

function isCursorLayerPlugin(pluginInstance) {
	var v = pluginInstance.value;
	return (
		!!v &&
		"view" in v &&
		v.view instanceof codemirrorView.EditorView &&
		"layer" in v &&
		isLayerSpec(v.layer) &&
		"measureReq" in v &&
		isMeasureReq(v.measureReq) &&
		"drawn" in v &&
		v.drawn instanceof Array &&
		"dom" in v &&
		v.dom instanceof HTMLElement &&
		"scaleX" in v &&
		typeof v.scaleX === "number" &&
		"scaleY" in v &&
		typeof v.scaleY === "number" &&
		v.layer.class === "cm-cursorLayer"
	);
}

function findCursorLayerPlugin(view) {
	return view.plugins.find(function (p) {
		return !!p.value && isCursorLayerPlugin(p);
	});
}

/*
 * === Patcher ===
 */

function applyPatch(layerPluginInstance) {
	return patchWith(layerPluginInstance.layer, {
		update: function () {
			return layerUpdate;
		},
		markers: function () {
			return makeMarkersGetter();
		},
	});
}

/*
 * === Default settings ===
 */
var DEFAULT_SETTINGS = {
	cursorWidth: 2,
	cursorColorDark: "#00BFFF",
	cursorColorLight: "#00BFFF",
	blink: true,
};

/*
 * === Settings tab ===
 */

var CursorSettingTab = (function (_super) {
	Object.setPrototypeOf(CursorSettingTab.prototype, _super.prototype);

	function CursorSettingTab(app, plugin) {
		_super.call(this, app, plugin);
		this.plugin = plugin;
	}

	CursorSettingTab.prototype.display = function () {
		var _this = this;
		var containerEl = this.containerEl;
		containerEl.empty();

		// Width sliders
		new obsidian.Setting(containerEl)
			.setName("Cursor width")
			.setDesc("Width of the cursor in pixels (1–6).")
			.addSlider(function (s) {
				s.setLimits(1, 6, 1)
					.setValue(_this.plugin.settings.cursorWidth)
					.setDynamicTooltip()
					.onChange(async function (v) {
						_this.plugin.settings.cursorWidth = v;
						await _this.plugin.saveSettings();
					});
			});

		// Light mode color
		new obsidian.Setting(containerEl)
			.setName("Light mode cursor color")
			.setDesc("Cursor color used when Obsidian is in light mode.")
			.addColorPicker(function (c) {
				c.setValue(_this.plugin.settings.cursorColorLight).onChange(
					async function (v) {
						_this.plugin.settings.cursorColorLight = v;
						await _this.plugin.saveSettings();
					},
				);
			});

		// Dark mode color
		new obsidian.Setting(containerEl)
			.setName("Dark mode cursor color")
			.setDesc("Cursor color used when Obsidian is in dark mode.")
			.addColorPicker(function (c) {
				c.setValue(_this.plugin.settings.cursorColorDark).onChange(
					async function (v) {
						_this.plugin.settings.cursorColorDark = v;
						await _this.plugin.saveSettings();
					},
				);
			});

		// Blink toggle
		new obsidian.Setting(containerEl)
			.setName("Cursor blink")
			.setDesc("Enable cursor blinking when idle.")
			.addToggle(function (t) {
				t.setValue(_this.plugin.settings.blink).onChange(async function (v) {
					_this.plugin.settings.blink = v;
					await _this.plugin.saveSettings();
				});
			});

		// Reset settings
		new obsidian.Setting(containerEl)
			.setName("Reset to defaults")
			.setDesc("Restore all cursor settings to their original values.")
			.addButton(function (b) {
				b.setButtonText("Reset")
					.setWarning()
					.onClick(async function () {
						_this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
						await _this.plugin.saveSettings();
						_this.display();
					});
			});
	};

	CursorSettingTab.prototype.hide = function () {
		this.containerEl.empty();
		obsidian.PluginSettingTab.prototype.hide.call(this);
	};

	return CursorSettingTab;
})(obsidian.PluginSettingTab);

/*
 * === Main plugin ===
 */

var NativeCursorPlugin = (function (_super) {
	Object.setPrototypeOf(NativeCursorPlugin.prototype, _super.prototype);

	function NativeCursorPlugin() {
		_super.apply(this, arguments);
		this.alreadyPatched = false;
		this.tryPatchRef = null;
		this.cursorPlugin = null;
		this.styleEl = null;
	}

	NativeCursorPlugin.prototype.onload = async function () {
		await this.loadSettings();
		this.alreadyPatched = false;

		this.styleEl = document.createElement("style");
		this.styleEl.id = "native-cursor-styles";
		document.head.appendChild(this.styleEl);
		this.applyStyles();

		this.addSettingTab(new CursorSettingTab(this.app, this));
		this.registerEditorExtension(tableCellViewPlugin);

		var activeEditor =
			this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
		if (activeEditor) {
			this.tryPatch(activeEditor);
		} else {
			this.tryPatchRef = this.app.workspace.on(
				"editor-selection-change",
				this.tryPatch.bind(this),
			);
		}
	};

	NativeCursorPlugin.prototype.applyStyles = function () {
		var s = this.settings;
		// Only dynamic, user-controlled values live here, all structural CSS in styles.css
		this.styleEl.textContent = [
			":root {",
			"  --cursor-width: " + s.cursorWidth + "px;",
			"  --cursor-color-dark: " + s.cursorColorDark + ";",
			"  --cursor-color-light: " + s.cursorColorLight + ";",
			"  --cursor-blink-name: " + (s.blink ? "cm-cursor-blink" : "none") + ";",
			"}",
		].join("\n");
	};

	NativeCursorPlugin.prototype.tryPatch = function (editor) {
		if (this.alreadyPatched) {
			this.cancelPatchAttempt();
			return;
		}
		var view = editor.cm;
		var found = findCursorLayerPlugin(view);
		if (found && found.value) {
			this.register(applyPatch(found.value));
			this.alreadyPatched = true;
			this.cursorPlugin = found;
			this.cancelPatchAttempt();
		}
	};

	NativeCursorPlugin.prototype.cancelPatchAttempt = function () {
		if (this.tryPatchRef) {
			this.app.workspace.offref(this.tryPatchRef);
			delete this.tryPatchRef;
		}
	};

	NativeCursorPlugin.prototype.onunload = function () {
		this.cancelPatchAttempt();
		if (this.styleEl) this.styleEl.remove();
	};

	NativeCursorPlugin.prototype.loadSettings = async function () {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	};

	NativeCursorPlugin.prototype.saveSettings = async function () {
		await this.saveData(this.settings);
		this.applyStyles();
	};

	return NativeCursorPlugin;
})(obsidian.Plugin);

module.exports = NativeCursorPlugin;
