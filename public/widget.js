/*
 * The embeddable form. On a page:
 *   <script src="https://your-instance/widget.js" data-key="pk_..." data-title="Acme" data-colour="#6b7a90" defer></script>
 * It loads nothing else and asks the server nothing until someone sends the form: a page view costs
 * the instance's database nothing. Its text and styles live in a shadow root, so neither page can
 * disturb the other, and everything shown is set as text, never as HTML.
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.dataset.key) return;
  var endpoint = new URL("/api/public/tickets", script.src).toString();
  var title = script.dataset.title || "Contact support";
  // Only a plain colour reaches the stylesheet below.
  var colour = /^#[0-9a-fA-F]{6}$/.test(script.dataset.colour || "") ? script.dataset.colour : "#334155";

  var host = document.createElement("div");
  var root = host.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent =
    ":host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;font:14px/1.4 system-ui,sans-serif;color:#111827}" +
    "button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:9px 14px;background:" + colour + ";color:#fff}" +
    "form{display:none;flex-direction:column;gap:8px;width:300px;max-width:calc(100vw - 40px);margin-bottom:10px;padding:16px;border-radius:12px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25)}" +
    "form.open{display:flex}h2{margin:0;font-size:15px}p{margin:0}" +
    "input,textarea{font:inherit;box-sizing:border-box;width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#111827}" +
    "textarea{min-height:96px;resize:vertical}.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}";
  root.appendChild(style);

  function field(tag, name, label, required, type) {
    var element = document.createElement(tag);
    element.name = name;
    element.placeholder = label;
    element.setAttribute("aria-label", label);
    element.required = required;
    if (type) element.type = type;
    return element;
  }

  var form = document.createElement("form");
  var heading = document.createElement("h2");
  heading.textContent = title;
  var status = document.createElement("p");
  status.setAttribute("role", "status");
  var send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  // A person never sees this field, and a form-filling robot fills it.
  var trap = document.createElement("div");
  trap.className = "trap";
  trap.setAttribute("aria-hidden", "true");
  var honeypot = field("input", "website", "Website", false);
  honeypot.tabIndex = -1;
  honeypot.autocomplete = "off";
  trap.appendChild(honeypot);
  [heading, field("input", "name", "Your name", false), field("input", "email", "Your email", true, "email"), field("input", "subject", "Subject", true), field("textarea", "message", "How can we help?", true), trap, send, status].forEach(function (part) {
    form.appendChild(part);
  });

  var open = document.createElement("button");
  open.type = "button";
  open.textContent = "Need help?";
  open.addEventListener("click", function () {
    form.classList.toggle("open");
  });

  /** What the host page wants the team to know, then where this was sent from. Without its query, which can hold someone's tokens. */
  function contextOf() {
    var fromPage = window.supportWidgetContext && typeof window.supportWidgetContext === "object" ? window.supportWidgetContext : {};
    return Object.assign({}, fromPage, { page: location.origin + location.pathname, userAgent: navigator.userAgent });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var values = new FormData(form);
    send.disabled = true;
    status.textContent = "Sending…";
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: script.dataset.key, name: values.get("name"), email: values.get("email"), subject: values.get("subject"), message: values.get("message"), website: values.get("website"), context: contextOf() }),
    })
      .then(function (response) {
        return response.json().then(function (answer) {
          if (!response.ok) throw new Error(answer.error || "That didn’t work.");
          form.reset();
          status.textContent = "Thanks: we got it, and we’ll answer by email.";
        });
      })
      .catch(function (error) {
        status.textContent = error.message || "That didn’t work: please try again.";
      })
      .finally(function () {
        send.disabled = false;
      });
  });

  root.appendChild(form);
  root.appendChild(open);
  document.body.appendChild(host);
})();
