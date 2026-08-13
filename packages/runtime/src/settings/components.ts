export function settingsSection(
  document: Document,
  title: string,
  trailing?: HTMLElement,
): HTMLElement {
  const section = document.createElement("section");
  section.style.cssText = "display:flex;flex-direction:column;gap:8px;";
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;";
  const heading = document.createElement("h2");
  heading.textContent = title;
  heading.style.cssText = "margin:0;font-size:14px;font-weight:600;";
  header.appendChild(heading);
  if (trailing) header.appendChild(trailing);
  section.appendChild(header);
  return section;
}

export function settingsCard(document: Document): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "border:1px solid rgba(255,255,255,.12)",
    "border-radius:12px",
    "overflow:hidden",
  ].join(";");
  return card;
}

export function settingsButton(
  document: Document,
  label: string,
  onClick: () => void | Promise<void>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "border:1px solid rgba(255,255,255,.14)",
    "border-radius:8px",
    "background:transparent",
    "color:inherit",
    "padding:6px 10px",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void onClick();
  });
  return button;
}

export function settingsSwitch(
  document: Document,
  initial: boolean,
  onChange: (next: boolean) => void | Promise<void>,
  marker = "data-claudepp-tweak-toggle",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute(marker, "true");
  button.style.cssText = [
    "width:34px",
    "height:20px",
    "border:0",
    "border-radius:999px",
    "padding:2px",
    "cursor:pointer",
  ].join(";");
  const knob = document.createElement("span");
  knob.style.cssText = [
    "display:block",
    "width:16px",
    "height:16px",
    "border-radius:50%",
    "background:white",
    "transition:transform .15s ease",
  ].join(";");
  button.appendChild(knob);
  const apply = (enabled: boolean): void => {
    button.setAttribute("aria-checked", String(enabled));
    button.style.background = enabled ? "#d97757" : "rgba(255,255,255,.2)";
    knob.style.transform = enabled ? "translateX(14px)" : "translateX(0)";
  };
  apply(initial);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = button.getAttribute("aria-checked") !== "true";
    apply(next);
    void Promise.resolve(onChange(next)).catch(() => apply(!next));
  });
  return button;
}

export function settingsMessageRow(
  document: Document,
  title: string,
  description?: string,
): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:14px;";
  const heading = document.createElement("div");
  heading.textContent = title;
  row.appendChild(heading);
  if (description) {
    const detail = document.createElement("div");
    detail.textContent = description;
    detail.style.cssText = "font-size:13px;opacity:.7;";
    row.appendChild(detail);
  }
  return row;
}
