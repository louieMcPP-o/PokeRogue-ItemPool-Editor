// Runs inside the PokeRogue page. Catches the reward-shop item pool and lets
// the popup read and change item weights. Changes apply the next time a shop
// is generated (including rerolls), and are remembered between visits.
(() => {
  if (window.prMod) return;

  const STORE_KEY = "prMod_weights";
  const FILL_KEY = "prMod_fill";
  const TIER_NAMES = ["Common", "Great", "Ultra", "Rogue", "Master"];
  const TIER_CHANCE = [768, 195, 48, 12, 1].map(n => n / 1024); // base chance a slot rolls each tier

  const mod = (window.prMod = {
    pool: null,            // [tier] -> array of pool entries
    originals: new Map(),  // entry -> its original weight (number or function)
    scene: null,           // the game's main BattleScene
  });

  const keyOf = (entry, tier) => `${tier}:${entry.modifierType.id}`;
  const prettify = id =>
    String(id).toLowerCase().split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function save(obj) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch {}
  }
  const fillOn = () => { try { return localStorage.getItem(FILL_KEY) === "1"; } catch { return false; } };

  // --- Finding the game ---
  // The game passes your party into item weight checks, and every Pokémon
  // knows which scene it belongs to, so that's how we find the main scene.
  function capture(party) {
    if (mod.scene) return;
    const s = party?.[0]?.scene;
    if (s && typeof s.getPlayerParty === "function") mod.scene = s;
  }

  function getParty() {
    try { return mod.scene ? mod.scene.getPlayerParty() : []; } catch { return []; }
  }

  // --- Weights ---
  // value undefined = game default. An override keeps the game's own
  // "this item can't appear for you right now" check, so it never forces
  // in an item that would make the shop retry forever.
  function makeWeight(orig, value) {
    if (typeof orig !== "function") return value === undefined ? orig : value;
    return (party, reroll) => {
      capture(party);
      let base = 0;
      try { base = Number(orig(party, reroll)) || 0; } catch {}
      if (value === undefined) return base;
      return base > 0 ? value : 0;
    };
  }

  function weightOf(w, party) {
    if (typeof w !== "function") return Number(w) || 0;
    try { return Number(w(party, 0)) || 0; } catch { return 0; }
  }
  const currentWeight = (entry, party) => weightOf(entry.weight, party);

  // The game also gives 0 weight to items you already have the max stack of
  // (held items are exempt). Mirror that so the safety check is accurate.
  function maxedOut(entry) {
    try {
      const id = entry.modifierType.id;
      const have = mod.scene?.findModifiers?.(m => m.type?.id === id, true) || [];
      if (!have.length || have.some(m => m.pokemonId !== undefined)) return false;
      return !have.some(m => m.stackCount < m.getMaxStackCount(true));
    } catch { return false; }
  }

  // --- Catch the item pool when the game builds a shop ---
  function registerPool(arrays) {
    mod.pool = arrays;
    const saved = loadSaved();
    arrays.forEach((arr, tier) => {
      if (!arr) return;
      for (const entry of arr) {
        if (mod.originals.has(entry)) continue;
        mod.originals.set(entry, entry.weight);
        const k = keyOf(entry, tier);
        entry.weight = makeWeight(entry.weight, k in saved ? saved[k] : undefined);
      }
    });
  }

  // Work out which tier list this is. Item tier labels can't be trusted (the
  // game re-labels items as weights change), so we go by the lists themselves:
  // the shop's Common list holds the Poké Ball, and the game always walks the
  // shop's tiers in order, Common to Master.
  let building = null;
  function shopTierOf(arr) {
    if (mod.pool) {
      const known = mod.pool.indexOf(arr);
      if (known !== -1) return known;
    }
    if (arr.some(e => e?.modifierType?.id === "POKEBALL")) {
      building = [arr];
      queueMicrotask(() => { building = null; });
      return 0;
    }
    if (building && building.length < TIER_NAMES.length) {
      building.push(arr);
      return building.length - 1;
    }
    return -1;
  }

  const origReduce = Array.prototype.reduce;
  Array.prototype.reduce = function (...args) {
    const first = this[0];
    if (first && typeof first === "object" && "maxWeight" in first && first.modifierType) {
      const tier = shopTierOf(this);
      if (tier !== -1) {
        if (building) registerPool(building.slice());
        hookShopPhase();

        // Safety net: if our changes leave this tier with nothing to pick,
        // use the game's normal weights for this tier this shop.
        if (mod.scene) {
          const party = getParty();
          let sum = 0;
          for (const e of this) if (!maxedOut(e)) sum += currentWeight(e, party);
          if (sum <= 0) {
            const ours = this.map(e => e.weight);
            for (const e of this) if (mod.originals.has(e)) e.weight = mod.originals.get(e);
            console.warn(`[Shop Odds] ${TIER_NAMES[tier]} tier had no items left; using normal odds for it this shop.`);
            try { return origReduce.apply(this, args); }
            finally { this.forEach((e, i) => { e.weight = ours[i]; }); }
          }
        }
      }
    }
    return origReduce.apply(this, args);
  };

  // --- The shop itself ---
  // The shop builds its items right after the odds are recalculated, so we
  // patch that step the first time we see the shop running.
  function hookShopPhase() {
    let phase;
    try { phase = mod.scene?.phaseManager?.getCurrentPhase(); } catch {}
    if (!phase || typeof phase.getModifierTypeOptions !== "function") return;
    let proto = Object.getPrototypeOf(phase);
    while (proto && !Object.hasOwn(proto, "getModifierTypeOptions")) proto = Object.getPrototypeOf(proto);
    if (!proto || proto.__prPatched) return;
    const orig = proto.getModifierTypeOptions;
    proto.getModifierTypeOptions = function (...args) {
      let opts;
      try {
        opts = orig.apply(this, args);
        if (!Array.isArray(opts) || opts.some(o => !o?.type)) throw new Error("shop came back with empty slots");
      } catch (e) {
        // Last resort so the game never freezes: a shop of Poké Balls.
        console.warn("[Shop Odds] the shop couldn't be built with your settings, so it's all Poké Balls this time.", e);
        const count = Math.max(1, Number(args[0]) || 3);
        opts = Array.from({ length: count }, () => makeBallOption());
        return opts.some(o => !o) ? orig.apply(this, args) : opts;
      }
      try { if (fillOn()) fillWithPokeballs(opts); } catch (e) { console.warn("[Shop Odds] fill failed", e); }
      return opts;
    };
    proto.__prPatched = true;
    console.log("[Shop Odds] attached to the shop.");
  }

  let OptionClass = null;
  function makeBallOption(cost = 0) {
    const ball = mod.pool?.[0]?.find(e => e.modifierType?.id === "POKEBALL");
    if (!ball) return null;
    return OptionClass
      ? new OptionClass(ball.modifierType, 0, cost)
      : { type: ball.modifierType, upgradeCount: 0, cost };
  }

  // "Only offer my items": every slot shows one of your switched-on items,
  // picked by your slider weights across ALL tiers (so a Master Ball you've
  // turned up can show without needing the rare Master tier roll). Once every
  // switched-on item is already on the shelf, the rest become Poké Balls.
  function fillWithPokeballs(opts) {
    if (!opts.length || !mod.pool?.[0]) return;
    OptionClass = opts[0].constructor;

    // Your switched-on items: weight above 0, usable right now, not maxed out
    const party = getParty();
    const chosen = new Map(); // id -> { entry, weight }
    mod.pool.forEach(arr => (arr || []).forEach(e => {
      const w = currentWeight(e, party);
      if (w > 0 && !maxedOut(e)) {
        const prev = chosen.get(e.modifierType.id);
        chosen.set(e.modifierType.id, { entry: e, weight: (prev?.weight || 0) + w });
      }
    }));

    const labelsOf = t => [t.name ?? t.id, t.group ? "g:" + t.group : null].filter(Boolean);
    const shownIds = new Set();
    const shownLabels = new Set();
    const keep = new Array(opts.length).fill(false);

    // 1. Keep slots that already rolled a chosen item (no repeats)
    opts.forEach((o, i) => {
      const t = o?.type;
      if (!t || !chosen.has(t.id) || shownIds.has(t.id)) return;
      if (labelsOf(t).some(l => shownLabels.has(l))) return;
      keep[i] = true;
      shownIds.add(t.id);
      labelsOf(t).forEach(l => shownLabels.add(l));
    });

    // 2. Fill the rest with weighted picks from chosen items not yet shown
    function pickChosen() {
      for (let attempt = 0; attempt < 10; attempt++) {
        const left = [...chosen].filter(([id]) => !shownIds.has(id));
        const total = left.reduce((s, [, c]) => s + c.weight, 0);
        if (!total) return null;
        let r = Math.random() * total;
        const [id, { entry }] = left.find(([, c]) => (r -= c.weight) < 0) || left[left.length - 1];
        shownIds.add(id);
        let type = entry.modifierType;
        if (typeof type.generateType === "function") {
          try { type = type.generateType(party); } catch { type = null; }
        }
        if (!type || labelsOf(type).some(l => shownLabels.has(l))) continue;
        labelsOf(type).forEach(l => shownLabels.add(l));
        return new OptionClass(type, 0, 0);
      }
      return null;
    }

    let added = 0, balls = 0;
    opts.forEach((o, i) => {
      if (keep[i]) return;
      const pick = pickChosen();
      if (pick) { opts[i] = pick; added++; return; }
      if (o?.type?.id === "POKEBALL") return;
      const ball = makeBallOption(0);
      if (ball) { opts[i] = ball; balls++; }
    });
    if (added || balls) console.log(`[Shop Odds] added ${added} of your items, ${balls} Poké Ball(s)`);
  }

  // --- Functions the popup calls ---
  mod.getFill = fillOn;
  mod.setFill = on => { try { localStorage.setItem(FILL_KEY, on ? "1" : "0"); } catch {} return on; };

  mod.getData = () => {
    if (!mod.pool) return { ready: false };
    const party = getParty();
    const saved = loadSaved();
    return {
      ready: true,
      fill: fillOn(),
      tiers: mod.pool.map((arr, tier) => ({
        name: TIER_NAMES[tier],
        chance: TIER_CHANCE[tier],
        items: (arr || []).map(entry => {
          const orig = mod.originals.get(entry);
          const k = keyOf(entry, tier);
          const defaultWeight = weightOf(orig, party);
          const conditional = typeof orig === "function";
          return {
            key: k,
            name: prettify(entry.modifierType.id),
            weight: k in saved ? saved[k] : defaultWeight,
            defaultWeight,
            conditional,
            available: (!conditional || defaultWeight > 0) && !maxedOut(entry),
            changed: k in saved,
          };
        }),
      })),
    };
  };

  mod.setWeight = (key, value) => {
    if (!mod.pool) return false;
    const [tier] = key.split(":");
    const entry = (mod.pool[tier] || []).find(e => keyOf(e, Number(tier)) === key);
    if (!entry) return false;
    const saved = loadSaved();
    const orig = mod.originals.get(entry);
    if (value === null) {
      entry.weight = makeWeight(orig, undefined);
      delete saved[key];
    } else {
      const v = Math.max(0, Number(value) || 0);
      entry.weight = makeWeight(orig, v);
      saved[key] = v;
    }
    save(saved);
    return true;
  };

  // Set many items at once (value null = back to default). tier undefined = every tier.
  mod.setAll = (value, tier) => {
    if (!mod.pool) return false;
    mod.pool.forEach((arr, t) => {
      if (tier !== undefined && tier !== null && t !== tier) return;
      (arr || []).forEach(e => mod.setWeight(keyOf(e, t), value));
    });
    return true;
  };

  mod.resetAll = () => {
    for (const [entry, w] of mod.originals) entry.weight = makeWeight(w, undefined);
    save({});
    return true;
  };

  console.log("[Shop Odds] loaded. Odds become editable after your first reward shop.");
})();