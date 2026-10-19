// The popup UI. Talks to mod.js in the PokeRogue tab via chrome.scripting.

const list = document.getElementById("list");
let data = null;

async function inPage(func, args = []) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://pokerogue.net")) throw new Error("not-pokerogue");
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: "MAIN", func, args,
  });
  return res?.result;
}

function showMessage(text) {
  list.innerHTML = `<div class="msg">${text}</div>`;
}

const pct = n => (n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3)) + "%";

function recalcOdds() {
  for (const tier of data.tiers) {
    const eff = it => (it.available ? it.weight : 0);
    const total = tier.items.reduce((s, it) => s + eff(it), 0);
    for (const it of tier.items) {
      const odds = total ? (eff(it) / total) * tier.chance * 100 : 0;
      if (it.oddsEl) it.oddsEl.textContent = pct(odds);
    }
  }
}

function render() {
  list.innerHTML = "";
  data.tiers.forEach((tier, tierIndex) => {
    const head = document.createElement("div");
    head.className = "tier";
    head.innerHTML = `${tier.name} <span>${pct(tier.chance * 100)} of slots<button title="Set this tier to 0">0</button></span>`;
    head.querySelector("button").addEventListener("click", async () => {
      await inPage(t => window.prMod?.setAll(0, t), [tierIndex]);
      load();
    });
    list.appendChild(head);

    for (const it of tier.items) {
      const max = Math.max(50, it.defaultWeight * 2, it.weight);
      const row = document.createElement("div");
      row.className = "row" + (it.changed ? " changed" : "") + (it.available ? "" : " blocked");
      row.dataset.name = it.name.toLowerCase();
      row.innerHTML = `
        <div class="name" title="${it.available ? `Default weight: ${it.defaultWeight}${it.conditional ? " (changes with your team)" : ""}` : "Can't appear for your team right now"}">${it.name}</div>
        <div class="odds"></div>
        <button class="reset" title="Back to default">↺</button>
        <div class="slider">
          <input type="range" min="0" max="${max}" step="1" value="${it.weight}">
          <input type="number" min="0" step="1" value="${it.weight}">
        </div>`;
      it.oddsEl = row.querySelector(".odds");
      const range = row.querySelector("input[type=range]");
      const num = row.querySelector("input[type=number]");

      const apply = async (value, commit) => {
        it.weight = Math.max(0, Number(value) || 0);
        range.value = it.weight;
        num.value = it.weight;
        recalcOdds();
        if (commit) {
          row.classList.add("changed");
          await inPage((k, w) => window.prMod?.setWeight(k, w), [it.key, it.weight]);
        }
      };
      range.addEventListener("input", () => apply(range.value, false));
      range.addEventListener("change", () => apply(range.value, true));
      num.addEventListener("change", () => apply(num.value, true));
      row.querySelector(".reset").addEventListener("click", async () => {
        await inPage(k => window.prMod?.setWeight(k, null), [it.key]);
        row.classList.remove("changed");
        it.weight = it.defaultWeight;
        range.value = num.value = it.weight;
        recalcOdds();
      });

      list.appendChild(row);
    }
  });
  recalcOdds();
}

async function load() {
  try {
    data = await inPage(() => (window.prMod ? window.prMod.getData() : null));
  } catch (e) {
    return showMessage(e.message === "not-pokerogue"
      ? "Open pokerogue.net in this tab, then click the extension again."
      : "Couldn't reach the game. Refresh the PokeRogue tab and try again.");
  }
  if (!data) return showMessage("The mod isn't running in this tab yet. Refresh PokeRogue.");
  if (!data.ready) return showMessage("Win a battle and reach the reward shop once, then open this again.");
  document.getElementById("fill").checked = !!data.fill;
  render();
}

document.getElementById("search").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  list.querySelectorAll(".row").forEach(r => r.classList.toggle("hidden", !!q && !r.dataset.name.includes(q)));
});

document.getElementById("allZero").addEventListener("click", async () => {
  try { await inPage(() => window.prMod?.setAll(0)); } catch {}
  load();
});

document.getElementById("fill").addEventListener("change", async e => {
  try { await inPage(on => window.prMod?.setFill(on), [e.target.checked]); } catch {}
});

document.getElementById("resetAll").addEventListener("click", async () => {
  try { await inPage(() => window.prMod?.resetAll()); } catch {}
  load();
});

load();