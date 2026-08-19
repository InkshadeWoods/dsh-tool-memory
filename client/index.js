/**
 * dsh-tool-memory — 设置面板浏览器半边。
 *
 * 在 dsh web 设置页注册「记忆」section：展示两个存储的占用统计，
 * 编辑基础配置与按需显示的 recall 配置并保存（POST 到 host 半边的同源路由；host 侧写
 * cordis.patch.yml 并尝试热重载）。React 运行时由宿主模块表提供
 * （require("react")），本文件不引入任何打包依赖。
 */
window.__ModuleLoader__.load({
  id: "dsh-tool-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const STATE_ROUTE = "/memory-plugin/api/state";
    const SETTINGS_ROUTE = "/memory-plugin/api/settings";

    const NOTIFY_OPTIONS = [
      { value: "off", label: "关闭（不发通知）" },
      { value: "on", label: "简短" },
      { value: "verbose", label: "详细（含条目摘要）" },
    ];

    const INJECTION_MODES = [
      {
        value: "snapshot",
        title: "传统冻结快照",
        description: "在新会话开始时注入完整记忆。稳定、可预测，并保留系统提示词前缀缓存。",
      },
      {
        value: "recall",
        title: "智能动态召回",
        description: "每次新提问只注入相关记忆与长期偏好，减少无关上下文；不命中时不会回退注入。",
      },
    ];

    const ROOT_FIELD = {
      key: "root", label: "记忆文件目录", type: "text", wide: true,
      hint: "MEMORY.md / USER.md 所在目录；留空使用默认 $DSH_HOME/memories",
    };

    const CAPACITY_FIELDS = [
      {
        key: "memoryCharLimit", label: "MEMORY.md 预算", type: "number", min: 0,
        hint: "代理笔记的字符预算",
      },
      {
        key: "userCharLimit", label: "USER.md 预算", type: "number", min: 0,
        hint: "用户画像的字符预算",
      },
    ];

    const REVIEW_BASIC_FIELDS = [
      {
        key: "nudgeInterval", label: "自动评审间隔", type: "number", min: 0,
        hint: "每 N 条用户消息触发一次后台评审；0 = 关闭",
      },
      {
        key: "reviewNotify", label: "评审通知", type: "select", options: NOTIFY_OPTIONS,
        hint: "评审完成后的通知档位",
      },
    ];

    const RECALL_BUDGET_FIELDS = [
      {
        key: "recallTopK", label: "动态条目数", type: "number", min: 1, max: 6,
        hint: "每轮最多渲染的相关记忆条数（1–6）",
      },
      {
        key: "recallMaxChars", label: "动态记忆总预算", type: "number", min: 200, max: 4000,
        hint: "本轮相关记忆的总字符预算（200–4000）",
      },
      {
        key: "recallPerItemChars", label: "单条记忆预算", type: "number", min: 80, max: 1200, wide: true,
        hint: "每条相关记忆的最大字符数（80–1200）",
      },
    ];

    const EMBEDDING_FIELDS = [
      {
        key: "recallEmbeddingBaseUrl", label: "Embedding Base URL", type: "text", wide: true,
        hint: "OpenAI 兼容 API 根地址；插件会自动追加 /embeddings。",
      },
      {
        key: "recallEmbeddingApiKey", label: "Embedding API Key", type: "password", wide: true,
        hint: "保存到本机 profile；状态接口不会返回。",
      },
      {
        key: "recallEmbeddingModel", label: "Embedding 模型", type: "text", wide: true,
        hint: "请求中的 model 字段；默认 Qwen/Qwen3-Embedding-8B。",
      },
    ];

    const RECALL_PRESETS = [
      {
        id: "balanced", title: "推荐 · 均衡", values: { recallTopK: 3, recallMaxChars: 1600, recallPerItemChars: 800 },
        description: "已验证配置，适合大多数技术任务。",
      },
      {
        id: "compact", title: "紧凑", values: { recallTopK: 3, recallMaxChars: 1200, recallPerItemChars: 420 },
        description: "更省上下文，适合短条目记忆。",
      },
      {
        id: "expanded", title: "扩展", values: { recallTopK: 4, recallMaxChars: 2400, recallPerItemChars: 900 },
        description: "保留更多长技术条目的细节。",
      },
    ];

    const styles = {
      page: { display: "flex", flexDirection: "column", gap: 16, width: "100%", minWidth: 420, maxWidth: 760, paddingBottom: 8 },
      title: { fontSize: 16, fontWeight: 600, margin: 0, color: "var(--dsw-alias-label-primary, #e0e0e0)" },
      intro: { fontSize: 12, lineHeight: 1.6, margin: 0, color: "var(--dsw-alias-label-tertiary, #888)" },
      card: {
        border: "1px solid var(--dsw-alias-border-l2, #333)",
        borderRadius: 8,
        background: "var(--dsw-alias-bg-layer-2, #2a2a2a)",
        padding: "12px 14px",
      },
      cardTitle: { fontSize: 14, fontWeight: 600, margin: "0 0 10px", color: "var(--dsw-alias-label-primary, #e0e0e0)" },
      row: { display: "flex", flexWrap: "wrap", gap: "18px 24px" },
      statusRow: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 },
      statusChip: (kind) => ({
        display: "inline-flex", alignItems: "center", minHeight: 26, padding: "0 9px", borderRadius: 999,
        fontSize: 12, lineHeight: 1.3, border: "1px solid rgba(148,163,184,0.3)",
        background: kind === "ok" ? "rgba(74,222,128,0.10)" : kind === "info" ? "rgba(96,165,250,0.10)" : "rgba(148,163,184,0.08)",
        color: kind === "ok" ? "#86efac" : kind === "info" ? "#93c5fd" : "var(--dsw-alias-label-secondary, #aaa)",
      }),
      modeGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 },
      modeCard: {
        display: "flex", alignItems: "flex-start", gap: 10, minHeight: 92, boxSizing: "border-box",
        padding: "12px", borderRadius: 8, cursor: "pointer", transition: "border-color 160ms ease, background 160ms ease",
        border: "1px solid var(--dsw-alias-border-l2, #444)", background: "var(--dsw-alias-bg-layer-1, #1e1e1e)",
      },
      modeCardSelected: { borderColor: "rgba(74,222,128,0.7)", background: "rgba(74,222,128,0.08)" },
      modeRadio: { marginTop: 2, accentColor: "#4ade80" },
      modeTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e0e0e0)" },
      modeDescription: { marginTop: 4, fontSize: 12, lineHeight: 1.55, color: "var(--dsw-alias-label-tertiary, #888)" },
      recallPanel: { marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--dsw-alias-border-l2, #333)" },
      presetGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 },
      preset: {
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 5, minHeight: 82, padding: "10px 11px",
        borderRadius: 8, cursor: "pointer", color: "inherit", textAlign: "left",
        border: "1px solid var(--dsw-alias-border-l2, #444)", background: "var(--dsw-alias-bg-layer-1, #1e1e1e)",
      },
      presetSelected: { borderColor: "rgba(74,222,128,0.7)", background: "rgba(74,222,128,0.08)" },
      presetTop: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: 8 },
      presetTitle: { fontSize: 12, fontWeight: 600 },
      presetCurrent: { padding: "2px 6px", borderRadius: 999, fontSize: 10, color: "#86efac", background: "rgba(74,222,128,0.12)" },
      presetDescription: { fontSize: 12, lineHeight: 1.45, color: "var(--dsw-alias-label-tertiary, #888)" },
      disclosure: {
        display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", minHeight: 38,
        padding: "0 2px", cursor: "pointer", border: 0, color: "inherit", textAlign: "left", background: "transparent",
      },
      disclosureTitle: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)" },
      settingsCard: {
        display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, width: "100%", minHeight: 62,
        boxSizing: "border-box", marginTop: 10, padding: "10px 12px", borderRadius: 8, cursor: "pointer", color: "inherit", textAlign: "left",
        border: "1px solid var(--dsw-alias-border-l2, #444)", background: "var(--dsw-alias-bg-layer-1, #1e1e1e)",
        transition: "border-color 160ms ease, background 160ms ease",
      },
      settingsCardOpen: { borderColor: "rgba(74,222,128,0.55)", background: "rgba(74,222,128,0.06)" },
      settingsCardCopy: { minWidth: 0, display: "block", flex: "1 1 auto" },
      settingsCardTitle: { display: "block", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e0e0e0)" },
      settingsCardDescription: { display: "block", marginTop: 4, fontSize: 12, lineHeight: 1.45, color: "var(--dsw-alias-label-tertiary, #888)" },
      settingsCardEnd: { display: "flex", flex: "0 0 auto", alignItems: "center", gap: 10, marginLeft: "auto" },
      settingsCardMeta: {
        display: "inline-flex", alignItems: "center", minHeight: 24, padding: "0 8px", borderRadius: 999,
        fontSize: 11, color: "#86efac", background: "rgba(74,222,128,0.10)", border: "1px solid rgba(74,222,128,0.20)",
      },
      settingsChevron: (open) => ({
        display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%",
        fontSize: 22, lineHeight: 1, color: open ? "#86efac" : "var(--dsw-alias-label-tertiary, #888)",
        background: open ? "rgba(74,222,128,0.12)" : "var(--dsw-alias-bg-layer-2, #2a2a2a)",
        transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 180ms ease, color 180ms ease",
      }),
      settingsContent: {
        marginTop: 10, padding: 12, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #3a3a3a)",
        background: "rgba(0,0,0,0.10)",
      },
      recallSettingsContent: {
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px 20px",
        marginTop: 10, padding: 12, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #3a3a3a)", background: "rgba(0,0,0,0.10)",
      },
      field: { display: "flex", flexDirection: "column", gap: 4, flex: "1 1 200px" },
      fieldWide: { display: "flex", flexDirection: "column", gap: 4, flex: "1 1 100%", gridColumn: "1 / -1" },
      label: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #aaa)" },
      toggleCard: {
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, width: "100%", minHeight: 64,
        boxSizing: "border-box", padding: "11px 12px", borderRadius: 8, cursor: "pointer", color: "inherit", textAlign: "left",
        border: "1px solid var(--dsw-alias-border-l2, #444)", background: "var(--dsw-alias-bg-layer-1, #1e1e1e)",
        transition: "border-color 160ms ease, background 160ms ease",
      },
      toggleCardEnabled: { borderColor: "rgba(74,222,128,0.65)", background: "rgba(74,222,128,0.08)" },
      toggleTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e0e0e0)" },
      toggleDescription: { marginTop: 4, fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, #888)" },
      toggleTrack: (enabled) => ({
        flex: "0 0 auto", display: "flex", alignItems: "center", width: 42, height: 24, padding: 3, boxSizing: "border-box",
        borderRadius: 999, background: enabled ? "#22c55e" : "var(--dsw-alias-border-l2, #555)",
        transition: "background 180ms ease",
      }),
      toggleThumb: (enabled) => ({
        display: "block", width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
        transform: enabled ? "translateX(18px)" : "translateX(0)", transition: "transform 180ms ease",
      }),
      input: {
        width: "100%", minHeight: 40, boxSizing: "border-box", padding: "7px 9px", fontSize: 13,
        borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #444)",
        background: "var(--dsw-alias-bg-layer-1, #1e1e1e)", color: "inherit",
      },
      hint: { fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, #888)" },
      capacityUsage: (pct) => ({ fontSize: 12, lineHeight: 1.45, color: pct >= 90 ? "#fca5a5" : pct >= 70 ? "#fcd34d" : "#86efac" }),
      infoBanner: { display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, padding: "9px 10px", borderRadius: 7, fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary, #aaa)", background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.20)" },
      infoIcon: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 17, height: 17, borderRadius: "50%", color: "#93c5fd", background: "rgba(96,165,250,0.16)", fontWeight: 700 },
      statLine: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, fontSize: 12 },
      statName: { color: "var(--dsw-alias-label-secondary, #aaa)" },
      statValue: { color: "var(--dsw-alias-label-primary, #e0e0e0)", fontVariantNumeric: "tabular-nums" },
      bar: { height: 6, borderRadius: 3, overflow: "hidden", background: "var(--dsw-alias-border-l2, #333)", marginTop: 6 },
      barFill: (pct) => ({ height: "100%", width: `${Math.min(100, pct)}%`, background: pct > 90 ? "#f87171" : "rgba(74,222,128,0.55)" }),
      actions: { display: "flex", alignItems: "center", gap: 10 },
      saveBar: {
        position: "sticky", bottom: 0, zIndex: 2, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
        padding: "10px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #333)",
        background: "var(--dsw-alias-bg-layer-2, #2a2a2a)", boxShadow: "0 -8px 24px rgba(0,0,0,0.18)",
      },
      button: {
        minHeight: 38, padding: "6px 14px", fontSize: 13, borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2, #444)",
        background: "var(--dsw-alias-bg-layer-1, #1e1e1e)", color: "inherit",
      },
      buttonPrimary: {
        minHeight: 38, padding: "6px 14px", fontSize: 13, borderRadius: 6,
        border: "1px solid rgba(74,222,128,0.35)", background: "rgba(74,222,128,0.12)",
        color: "#4ade80",
      },
      notice: (kind) => ({
        fontSize: 12, lineHeight: 1.6, padding: "8px 10px", borderRadius: 6,
        background: kind === "error" ? "rgba(248,113,113,0.1)" : "rgba(74,222,128,0.08)",
        color: kind === "error" ? "#f87171" : "#4ade80",
      }),
      saveStatus: (dirty) => ({ display: "inline-flex", alignItems: "center", minHeight: 28, padding: "0 9px", borderRadius: 999, fontSize: 12, color: dirty ? "#fcd34d" : "#86efac", background: dirty ? "rgba(250,204,21,0.09)" : "rgba(74,222,128,0.09)", border: `1px solid ${dirty ? "rgba(250,204,21,0.20)" : "rgba(74,222,128,0.20)"}` }),
      pathLine: { fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #888)", wordBreak: "break-all" },
    };

    function fieldNode(field, draft, onChange, options = {}) {
      const id = `memory-config-${field.key}`;
      const usage = options.usage?.[field.key];
      const usagePercent = usage && usage.limit > 0 ? Math.round((usage.chars / usage.limit) * 100) : 0;
      let control;
      if (field.type === "select") {
        control = h("select", {
          id, style: styles.input, value: draft[field.key],
          onChange: (e) => onChange(field.key, e.target.value),
        }, field.options.map((opt) => h("option", { key: opt.value, value: opt.value }, opt.label)));
      } else if (field.type === "number") {
        control = h("input", {
          id, type: "number", min: field.min, max: field.max, style: styles.input,
          value: String(draft[field.key]),
          onChange: (e) => onChange(field.key, e.target.value === "" ? 0 : Number(e.target.value)),
        });
      } else if (field.type === "checkbox") {
        control = h("input", {
          id, type: "checkbox", checked: draft[field.key] === true,
          onChange: (e) => onChange(field.key, e.target.checked),
        });
      } else {
        control = h("input", {
          id, type: field.type === "password" ? "password" : "text", style: styles.input, value: draft[field.key],
          placeholder: field.type === "password" && options.embeddingApiKeyConfigured ? "已保存；留空不改动" : undefined,
          autoComplete: field.type === "password" ? "new-password" : undefined,
          onChange: (e) => onChange(field.key, e.target.value),
        });
      }
      return h("div", { key: field.key, style: field.wide ? styles.fieldWide : styles.field },
        h("label", { htmlFor: id, style: styles.label }, field.label),
        control,
        field.type === "password" ? h("div", {
          style: {
            ...styles.hint,
            marginTop: 7,
            color: options.embeddingApiKeyConfigured ? "#4ade80" : "var(--dsw-alias-label-tertiary, #888)",
          },
        }, options.embeddingApiKeyConfigured
          ? "已安全保存至本机 profile；留空不改动，输入新 Key 后保存即可替换。"
          : "尚未保存本机 Key；输入后点击保存，保存成功后这里会显示状态。"
        ) : null,
        field.hint && field.type !== "password" ? h("div", { style: styles.hint }, field.hint) : null,
        usage ? h("div", { style: styles.capacityUsage(usagePercent) },
          `当前占用：${usage.chars.toLocaleString()} / ${usage.limit.toLocaleString()} 字符（${usagePercent}%）`
        ) : null,
      );
    }

    function semanticToggle(draft, onChange) {
      const enabled = draft.recallEmbeddingEnabled === true;
      return h("button", {
        type: "button", role: "switch", "aria-checked": enabled,
        "aria-label": "启用语义增强",
        style: enabled ? { ...styles.toggleCard, ...styles.toggleCardEnabled } : styles.toggleCard,
        onClick: () => onChange("recallEmbeddingEnabled", !enabled),
      },
        h("span", null,
          h("span", { style: styles.toggleTitle }, "启用语义增强"),
          h("span", { style: styles.toggleDescription }, enabled
            ? "已启用；服务不可用时会自动回退本地检索。"
            : "关闭时只使用本地检索，不会请求 embedding 服务。"
          ),
        ),
        h("span", { "aria-hidden": true, style: styles.toggleTrack(enabled) },
          h("span", { style: styles.toggleThumb(enabled) }),
        ),
      );
    }

    function reviewRouteField(draft, modelRoutes, onRouteChange) {
      const currentKey = draft.reviewProvider && draft.reviewModel
        ? `${draft.reviewProvider}\u0000${draft.reviewModel}`
        : "";
      const currentIsPartial = Boolean(draft.reviewProvider || draft.reviewModel) && !currentKey;
      const routes = Array.isArray(modelRoutes) ? modelRoutes : [];
      const currentIsListed = currentKey && routes.some((route) => `${route.provider}\u0000${route.model}` === currentKey);
      const selectValue = currentKey && !currentIsListed ? `custom\u0000${currentKey}` : currentKey;

      return h("div", { style: styles.fieldWide },
        h("label", { htmlFor: "memory-review-route", style: styles.label }, "评审模型路由"),
        h("select", {
          id: "memory-review-route", style: styles.input, value: selectValue,
          onChange: (event) => onRouteChange(event.target.value),
        },
          h("option", { value: "" }, "继承当前会话模型（推荐）"),
          currentKey && !currentIsListed ? h("option", { value: `custom\u0000${currentKey}` }, `当前自定义：${draft.reviewProvider} / ${draft.reviewModel}`) : null,
          currentIsPartial ? h("option", { value: `partial\u0000${draft.reviewProvider}\u0000${draft.reviewModel}` }, "当前配置不完整；请选择完整路由或继承") : null,
          routes.map((route) => h("option", {
            key: `${route.provider}\u0000${route.model}`,
            value: `${route.provider}\u0000${route.model}`,
          }, `${route.providerName} · ${route.modelName}`)),
        ),
        h("div", { style: styles.hint }, routes.length > 0
          ? "选择后会自动成对设置 DSH 的 Provider 与模型 ID；不需要填写 API 地址或 Key。"
          : "暂未读取到 DSH 模型目录；保留“继承当前会话”即可。"
        ),
      );
    }

    function settingsCard({ title, description, summary, expanded, onClick }) {
      return h("button", {
        type: "button", "aria-expanded": expanded, style: expanded
          ? { ...styles.settingsCard, ...styles.settingsCardOpen }
          : styles.settingsCard,
        onClick,
      },
        h("span", { style: styles.settingsCardCopy },
          h("span", { style: styles.settingsCardTitle }, title),
          h("span", { style: styles.settingsCardDescription }, description),
        ),
        h("span", { style: styles.settingsCardEnd },
          h("span", { style: styles.settingsCardMeta }, summary),
          h("span", { "aria-hidden": true, style: styles.settingsChevron(expanded) }, "›"),
        ),
      );
    }

    function injectionModeCard(mode, draft, onChange) {
      const selected = draft.injectionMode === mode.value;
      return h("label", {
        key: mode.value,
        style: selected ? { ...styles.modeCard, ...styles.modeCardSelected } : styles.modeCard,
      },
        h("input", {
          type: "radio", name: "memory-injection-mode", value: mode.value,
          checked: selected, style: styles.modeRadio,
          onChange: () => onChange("injectionMode", mode.value),
        }),
        h("span", null,
          h("div", { style: styles.modeTitle }, mode.title),
          h("div", { style: styles.modeDescription }, mode.description),
        ),
      );
    }

    function statBlock(name, stat) {
      const pct = stat.limit > 0 ? Math.round((stat.chars / stat.limit) * 100) : 0;
      return h("div", null,
        h("div", { style: styles.statLine },
          h("span", { style: styles.statName }, name),
          h("span", { style: styles.statValue },
            `${stat.entries} 条 · ${stat.chars.toLocaleString()} / ${stat.limit.toLocaleString()} 字符（${pct}%）`),
        ),
        h("div", { style: styles.bar }, h("div", { style: styles.barFill(pct) })),
      );
    }

    function MemorySettings() {
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);
      const [clearEmbeddingApiKey, setClearEmbeddingApiKey] = useState(false);
      const [showRecallAdvanced, setShowRecallAdvanced] = useState(false);
      const [showEmbeddingSettings, setShowEmbeddingSettings] = useState(false);
      const [showReviewAdvanced, setShowReviewAdvanced] = useState(false);
      const [showStorageLocation, setShowStorageLocation] = useState(false);

      const reload = useCallback(async (clearNotice = true) => {
        try {
          const res = await fetch(STATE_ROUTE);
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setState(body);
          setDraft(body.config);
          if (clearNotice) setNotice(null);
        } catch (error) {
          setNotice({ kind: "error", text: `读取状态失败：${error.message}` });
        }
      }, []);

      useEffect(() => { reload(); }, [reload]);

      if (!state || !draft) {
        return h("div", { style: styles.page },
          h("h2", { style: styles.title }, "跨会话记忆"),
          notice ? h("div", { style: styles.notice(notice.kind) }, notice.text) : h("div", { style: styles.intro }, "加载中…"),
        );
      }

      const dirty = JSON.stringify(draft) !== JSON.stringify(state.config) || clearEmbeddingApiKey;
      const recallMode = draft.injectionMode === "recall";
      const recallStatus = state.recallStatus;
      const modelRoutes = Array.isArray(state.modelRoutes) ? state.modelRoutes : [];
      const recallIndexLoaded = recallStatus?.indexLoaded === true;
      const embeddingApiKeyConfigured = state.embeddingApiKeyConfigured === true;
      const semanticIndexLabel = !draft.recallEmbeddingEnabled
        ? "未启用"
        : recallStatus?.vectorState === "ready"
          ? "已就绪"
          : recallStatus?.vectorState === "warming"
            ? "预热中"
            : "等待首轮召回";
      const selectedRecallPreset = RECALL_PRESETS.find((preset) => Object.keys(preset.values).every((key) => draft[key] === preset.values[key]));
      const recallRangeSummary = selectedRecallPreset
        ? selectedRecallPreset.title
        : `${draft.recallTopK} 条 · ${draft.recallMaxChars} 字 · 每条 ${draft.recallPerItemChars} 字`;
      const reviewNotifyLabel = NOTIFY_OPTIONS.find((option) => option.value === draft.reviewNotify)?.label ?? "简短";
      const reviewSummary = draft.nudgeInterval === 0 ? "已关闭" : `每 ${draft.nudgeInterval} 条 · ${reviewNotifyLabel}`;

      const onChange = (key, value) => {
        if (key === "recallEmbeddingApiKey" && String(value).trim()) setClearEmbeddingApiKey(false);
        if (key === "recallEmbeddingEnabled" && value === true) setShowEmbeddingSettings(true);
        setDraft((prev) => ({ ...prev, [key]: value }));
      };

      const onReviewRouteChange = (value) => {
        if (value === "") {
          setDraft((prev) => ({ ...prev, reviewProvider: "", reviewModel: "" }));
          return;
        }
        if (value.startsWith("custom\u0000") || value.startsWith("partial\u0000")) return;
        const route = modelRoutes.find((item) => `${item.provider}\u0000${item.model}` === value);
        if (route) setDraft((prev) => ({ ...prev, reviewProvider: route.provider, reviewModel: route.model }));
      };

      const applyPreset = (preset) => setDraft((prev) => ({ ...prev, ...preset.values }));

      const copySharedDirectory = async () => {
        try {
          await navigator.clipboard.writeText(state.resolvedRoot);
          setNotice({ kind: "ok", text: "共享记忆目录已复制。" });
        } catch (error) {
          setNotice({ kind: "error", text: "复制目录失败，请手动复制上方路径。" });
        }
      };

      const save = async () => {
        setSaving(true);
        setNotice(null);
        try {
          const res = await fetch(SETTINGS_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: draft, clearEmbeddingApiKey }),
          });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setNotice({
            kind: "ok",
            text: `${body.reloaded ? "已保存，并已热重载生效。" : "已保存；重启 dsh 后生效。"}${body.embeddingApiKeyConfigured ? " Embedding API Key 已安全保存（不会回显）。" : clearEmbeddingApiKey ? " 已清除已保存的 Embedding API Key。" : ""}`,
          });
          await reload(false);
        } catch (error) {
          setNotice({ kind: "error", text: `保存失败：${error.message}` });
        } finally {
          setSaving(false);
        }
      };

      const reset = () => { setDraft({ ...state.config }); setClearEmbeddingApiKey(false); setNotice(null); };

      return h("div", { style: styles.page },
        h("h2", { style: styles.title }, "跨会话记忆"),
        h("p", { style: styles.intro },
          "同一份 MEMORY.md 与 USER.md 可供 DSH、ZCode 与 Hermes 共用；这里仅调整 DSH 的读取、注入与自动评审方式。"),

        h("section", { style: styles.card },
          h("h3", { style: styles.cardTitle }, "共享记忆存储"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
            statBlock("MEMORY.md（代理笔记）", state.stats.memory),
            statBlock("USER.md（用户画像）", state.stats.user),
          ),
          h("div", { style: { ...styles.pathLine, marginTop: 10 } }, `共享目录：${state.resolvedRoot}`),
          h("div", { style: { ...styles.actions, marginTop: 10 } },
            h("button", { type: "button", style: styles.button, onClick: copySharedDirectory }, "复制共享目录"),
            state.patchFile ? h("span", { style: styles.hint }, "设置只保存在本机 profile。") : null,
          ),
          settingsCard({
            title: "更改共享目录", description: "MEMORY.md 与 USER.md 的共同存放位置",
            summary: draft.root.trim() ? "自定义目录" : "使用默认目录",
            expanded: showStorageLocation,
            onClick: () => setShowStorageLocation((open) => !open),
          }),
          showStorageLocation ? h("div", { style: styles.settingsContent }, fieldNode(ROOT_FIELD, draft, onChange)) : null,
        ),

        h("section", { style: styles.card },
          h("h3", { style: styles.cardTitle }, "记忆注入方式"),
          h("p", { style: { ...styles.intro, marginBottom: 12 } },
            "两种模式读取同一份 MEMORY.md 与 USER.md；切换只改变模型上下文的注入方式。"),
          h("div", { style: styles.modeGrid }, INJECTION_MODES.map((mode) => injectionModeCard(mode, draft, onChange))),
          recallMode ? h("div", { style: styles.recallPanel },
            h("h4", { style: { ...styles.cardTitle, marginBottom: 8 } }, "快速配置"),
            h("p", { style: { ...styles.intro, marginBottom: 10 } }, "选择预设即可调整动态条目数与字符预算；推荐配置已通过长技术记忆测试。"),
            h("div", { style: styles.presetGrid }, RECALL_PRESETS.map((preset) => {
              const selected = Object.keys(preset.values).every((key) => draft[key] === preset.values[key]);
              return h("button", {
                key: preset.id, type: "button", onClick: () => applyPreset(preset),
                style: selected ? { ...styles.preset, ...styles.presetSelected } : styles.preset,
              },
                h("span", { style: styles.presetTop },
                  h("span", { style: styles.presetTitle }, preset.title),
                  selected ? h("span", { style: styles.presetCurrent }, "当前使用") : null,
                ),
                h("span", { style: styles.presetDescription }, preset.description),
              );
            })),
            recallStatus ? h("div", { style: styles.statusRow },
              !recallIndexLoaded
                ? h("div", { style: styles.infoBanner },
                  h("span", { style: styles.infoIcon }, "i"),
                  h("span", null, "共享记忆尚未加载。首次提问时会自动从 MEMORY.md 与 USER.md 建立运行时索引；记忆文件本身不会丢失。"),
                )
                : [
                  h("span", { key: "dynamic", style: styles.statusChip("ok") }, `动态候选 ${recallStatus.dynamicEntries} 条`),
                  h("span", { key: "core", style: styles.statusChip("info") }, `常驻核心 ${recallStatus.coreEntries} 条`),
                  h("span", { key: "vector", style: styles.statusChip(semanticIndexLabel === "已就绪" ? "ok" : "neutral") },
                    `语义索引 ${semanticIndexLabel}`),
                ],
            ) : null,

            h("div", { style: { ...styles.recallPanel, marginTop: 16 } },
              h("h4", { style: { ...styles.cardTitle, marginBottom: 8 } }, "语义增强（可选）"),
              semanticToggle(draft, onChange),
              draft.recallEmbeddingEnabled ? h("div", { style: { marginTop: 8 } },
                h("div", { style: styles.statusRow },
                  h("span", { style: styles.statusChip(embeddingApiKeyConfigured ? "ok" : "neutral") },
                    embeddingApiKeyConfigured ? "本机 API Key 已保存" : "未保存本机 Key；可使用环境变量回退"),
                ),
                settingsCard({
                  title: "服务设置", description: "Base URL、API Key 与 Embedding 模型",
                  summary: embeddingApiKeyConfigured ? "本机 API Key 已保存" : "未保存本机 Key；可使用环境变量回退",
                  expanded: showEmbeddingSettings,
                  onClick: () => setShowEmbeddingSettings((open) => !open),
                }),
                showEmbeddingSettings ? h("div", { style: { ...styles.row, ...styles.settingsContent } }, EMBEDDING_FIELDS.map((field) => fieldNode(field, draft, onChange, { embeddingApiKeyConfigured }))) : null,
                embeddingApiKeyConfigured && showEmbeddingSettings ? h("label", { style: { ...styles.hint, display: "flex", alignItems: "center", gap: 6, marginTop: 10 } },
                  h("input", { type: "checkbox", checked: clearEmbeddingApiKey, onChange: (e) => setClearEmbeddingApiKey(e.target.checked) }),
                  "清除已保存的 Embedding API Key（保存后生效）",
                ) : null,
              ) : null,
            ),

            settingsCard({
              title: "调整召回范围", description: "动态条目数与上下文字符预算",
              summary: recallRangeSummary,
              expanded: showRecallAdvanced,
              onClick: () => setShowRecallAdvanced((open) => !open),
            }),
            showRecallAdvanced ? h("div", { style: styles.recallSettingsContent }, RECALL_BUDGET_FIELDS.map((field) => fieldNode(field, draft, onChange))) : null,
          ) : null,
        ),

        h("section", { style: styles.card },
          h("h3", { style: styles.cardTitle }, "容量预算"),
          h("p", { style: { ...styles.intro, marginBottom: 12 } }, "预算仅限制 DSH 单次读取的字符量，不会修改共享记忆文件。"),
          h("div", { style: styles.row }, CAPACITY_FIELDS.map((field) => fieldNode(field, draft, onChange, {
            usage: {
              memoryCharLimit: state.stats.memory,
              userCharLimit: state.stats.user,
            },
          }))),
        ),

        h("section", { style: styles.card },
          h("h3", { style: styles.cardTitle }, "自动记忆评审（高级）"),
          settingsCard({
            title: "评审规则", description: "后台定期整理值得长期保留的信息；默认继承当前会话模型。",
            summary: reviewSummary,
            expanded: showReviewAdvanced,
            onClick: () => setShowReviewAdvanced((open) => !open),
          }),
          showReviewAdvanced ? h("div", { style: { ...styles.row, ...styles.settingsContent } },
            reviewRouteField(draft, modelRoutes, onReviewRouteChange),
            REVIEW_BASIC_FIELDS.map((field) => fieldNode(field, draft, onChange)),
          ) : null,
        ),

        h("div", { style: styles.saveBar },
          h("div", { style: { flex: "1 1 180px" } },
            h("span", { style: styles.saveStatus(dirty) }, dirty ? "有未保存的修改" : "当前配置已保存")),
          h("div", { style: styles.actions },
            h("button", {
              type: "button", style: dirty && !saving ? styles.buttonPrimary : { ...styles.buttonPrimary, opacity: 0.5, cursor: "default" },
              disabled: !dirty || saving,
              onClick: save,
            }, saving ? "保存中…" : "保存"),
            h("button", { type: "button", style: styles.button, disabled: !dirty || saving, onClick: reset }, "放弃修改"),
          ),
          notice ? h("div", { style: { ...styles.notice(notice.kind), flex: "1 1 100%" } }, notice.text) : null,
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "memory",
            order: 110,
            label: () => "记忆",
          },
          MemorySettings,
        )
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
