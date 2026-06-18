(function () {
  const PROTOCOL_EVENTS = ["runtime_ready", "draw_click", "draw_result", "flatten_complete", "roll_start", "roll_complete"];
  const config = window.__CAMPAIGN_PREVIEW_CONFIG__ || {};
  const pack = window.__CAMPAIGN_IMPLEMENTATION_PACK__ || {};
  const layoutGroup = pack.layout_group || {};
  const motionGroup = pack.motion_group || {};
  const sprites = pack.sprites || {};
  const copywriting = pack.copywriting || {};
  const sessionId = "sess_" + Math.random().toString(16).slice(2);
  let autoTimer = 0;
  let resumeTimer = 0;
  let centerIndex = 2;
  let locked = false;
  let requestCounter = 0;
  let pendingRequestId = "";
  let pendingResult = null;

  function track(eventName, payload) {
    try {
      const baseUrl = config.api_base_url === "__API_BASE_URL__" ? "" : (config.api_base_url || "");
      if (!baseUrl) return;
      fetch(baseUrl + "/v1/preview-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preview_id: config.preview_id,
          campaign_id: config.campaign_id,
          version: config.version,
          event_name: eventName,
          session_id: sessionId,
          payload: payload || {}
        })
      }).catch(function () {});
    } catch (_) {}
  }
  function dispatchRuntimeEvent(type, payload) {
    const detail = { type: type, payload: payload || {} };
    document.dispatchEvent(new CustomEvent("campaign_runtime_event", { detail: detail }));
    track(type, payload || {});
  }
  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function numberValue(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function arrayValue(value, fallback) {
    return Array.isArray(value) && value.length ? value : fallback;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }
  function positiveModulo(value, modulo) {
    return ((value % modulo) + modulo) % modulo;
  }
  function rollingConfig() {
    const catalog = asRecord(motionGroup.catalog);
    const manual = asRecord(catalog.manual_swipe);
    const flatten = asRecord(motionGroup.flatten_to_lane);
    const roll = asRecord(motionGroup.roll);
    const reveal = asRecord(motionGroup.winning_reveal);
    return {
      auto_cycle_ms: numberValue(catalog.auto_cycle_interval_ms, 2000),
      initial_auto_cycle_delay_ms: numberValue(catalog.initial_auto_cycle_delay_ms, 2000),
      manual_resume_delay_ms: numberValue(manual.resume_auto_cycle_delay_ms, 4000),
      default_transition_ms: numberValue(catalog.cycle_duration_ms, 360),
      drag_threshold_px: numberValue(manual.threshold_px, 49),
      drag_feedback_ratio: numberValue(manual.drag_feedback_factor, 0.28),
      drag_feedback_limit_px: numberValue(manual.drag_feedback_clamp_px, 29),
      draw_align_ms: numberValue(flatten.duration_ms, 400),
      draw_align_pause_ms: numberValue(flatten.post_hold_ms, 200),
      roll_duration_ms: numberValue(roll.duration_ms, 6000),
      roll_step_px: numberValue(roll.step_px, 146),
      roll_variants: arrayValue(roll.roll_variants, [19, 22, 25]),
      pre_padding_count: numberValue(roll.pre_padding_count, 2),
      tail_padding_count: numberValue(roll.tail_padding_count, 6),
      roll_easing: String(roll.css_cubic_bezier || "cubic-bezier(0.23, 1, 0.32, 1)"),
      reveal_scales: asRecord(reveal.rarity_final_scale)
    };
  }
  const rollConfig = rollingConfig();
  function cardCatalogSlots() {
    const configured = Array.isArray(layoutGroup.card_catalog_slots) ? layoutGroup.card_catalog_slots : [];
    if (configured.length >= 5) return configured.slice(0, 5).map(asRecord);
    return [
      { x: 7, y: 63, w: 111, h: 172, z: 1 },
      { x: 125, y: 38, w: 139, h: 217, z: 2 },
      { x: 271, y: 0, w: 208, h: 272, z: 4 },
      { x: 486, y: 38, w: 139, h: 217, z: 2 },
      { x: 632, y: 63, w: 111, h: 172, z: 1 }
    ];
  }
  function cardStripViewport() {
    const slots = asRecord(layoutGroup.slots);
    return asRecord(slots.card_strip_viewport || { w: 750, h: 299 });
  }
  function cards() {
    const configured = Array.isArray(sprites.cards) ? sprites.cards : [];
    if (configured.length) return configured.slice(0, 5);
    const slots = Array.isArray(copywriting.coupon_slots) ? copywriting.coupon_slots : ["满20减5", "满30减10", "第二杯半价", "免费升杯券", "幸运免单券"];
    return slots.slice(0, 5).map(function (label, index) {
      const giftId = "gift_" + (index + 1);
      return { gift_id: giftId, id: giftId + "_card", display_label: label, file: "theme_assets/sprites/cards/" + giftId + "-card.png" };
    });
  }
  function giftIdFor(card, index) {
    return String(card.gift_id || card.id || ("gift_" + (index + 1)));
  }
  function labelFor(card, index) {
    return String(card.display_label || card.name || giftIdFor(card, index));
  }
  function rarityForIndex(index, length) {
    if (index === length - 1) return "legendary";
    if (index >= length - 2) return "rare";
    return "common";
  }
  function slotClassFor(index, length) {
    const half = Math.floor(length / 2);
    let relative = (index - centerIndex + length) % length;
    if (relative > half) relative -= length;
    if (relative === -2) return "slot-left-far";
    if (relative === -1) return "slot-left";
    if (relative === 0) return "slot-center";
    if (relative === 1) return "slot-right";
    return "slot-right-far";
  }
  function defaultSlotIndexFor(index, length) {
    const className = slotClassFor(index, length);
    if (className === "slot-left-far") return 0;
    if (className === "slot-left") return 1;
    if (className === "slot-center") return 2;
    if (className === "slot-right") return 3;
    return 4;
  }
  function percent(value, denominator) {
    return (numberValue(value, 0) / numberValue(denominator, 1) * 100) + "%";
  }
  function applyCatalogSlots(cardNode, index, length) {
    const slots = cardCatalogSlots();
    const viewport = cardStripViewport();
    const slot = slots[defaultSlotIndexFor(index, length)] || {};
    cardNode.style.left = percent(slot.x, viewport.w || 750);
    cardNode.style.top = percent(slot.y, viewport.h || 299);
    cardNode.style.width = percent(slot.w, viewport.w || 750);
    cardNode.style.height = percent(slot.h, viewport.h || 299);
    cardNode.style.zIndex = String(numberValue(slot.z, 1));
    cardNode.style.transform = "none";
  }
  function assetSrc(file) {
    const value = String(file || "");
    if (!value) return "";
    if (/^(https?:|data:|\.\/)/.test(value)) return value;
    return "./" + value.replace(/^\/+/, "");
  }
  function renderCard(card, index, options) {
    const length = cards().length || 5;
    const rarity = options && options.rarity ? options.rarity : rarityForIndex(index, length);
    const giftId = options && options.giftId ? options.giftId : giftIdFor(card, index);
    const trackIndex = options && Number.isFinite(options.trackIndex) ? ' data-track-index="' + options.trackIndex + '"' : "";
    const style = options && options.trackX !== undefined ? ' style="--track-x: ' + options.trackX + 'px;"' : "";
    const image = card.file ? '<img class="rolling-card-image" src="' + escapeHtml(assetSrc(card.file)) + '" alt="">' : "";
    const className = image ? "rolling-card rolling-card-sprite" : "rolling-card rolling-card-fallback";
    const content = image || '<span class="rolling-card-fallback-text">' + escapeHtml(labelFor(card, index)) + '</span>';
    return '<article class="' + className + '" data-gift-id="' + escapeHtml(giftId) + '" data-rarity="' + escapeHtml(rarity) + '" data-prize-label="' + escapeHtml(labelFor(card, index)) + '"' + trackIndex + style + ' role="listitem">' +
      content +
    '</article>';
  }
  function stopAutoCycle() {
    if (autoTimer) window.clearInterval(autoTimer);
    if (resumeTimer) window.clearTimeout(resumeTimer);
    autoTimer = 0;
    resumeTimer = 0;
  }
  function scheduleAutoCycle(delayMs) {
    const delay = numberValue(delayMs, rollConfig.auto_cycle_ms);
    stopAutoCycle();
    if (locked) return;
    resumeTimer = window.setTimeout(function () {
      autoTimer = window.setInterval(function () {
        rotateDefaultCards(1, "auto");
      }, rollConfig.auto_cycle_ms);
    }, delay);
  }
  function applyDefaultSlots(strip) {
    const cardNodes = Array.prototype.slice.call(strip.querySelectorAll(".rolling-card"));
    const length = cardNodes.length || 5;
    cardNodes.forEach(function (card, index) {
      card.classList.remove("is-winning", "winning-reveal");
      card.style.removeProperty("--track-x");
      card.style.removeProperty("--winning-scale");
      applyCatalogSlots(card, index, length);
    });
  }
  function renderDefaultStrip(zone, strip) {
    const cardList = cards();
    strip.classList.remove("is-track");
    zone.classList.remove("is-rolling", "is-aligning");
    strip.style.transition = "";
    strip.style.transform = "translate3d(0, 0, 0)";
    strip.style.removeProperty("--track-card-width");
    strip.innerHTML = cardList.map(function (card, index) {
      return renderCard(card, index, { giftId: giftIdFor(card, index), rarity: rarityForIndex(index, cardList.length) });
    }).join("");
    applyDefaultSlots(strip);
  }
  function rotateDefaultCards(direction, source) {
    const strip = document.getElementById("rolling_card_strip");
    if (!strip || locked || strip.classList.contains("is-track")) return;
    const length = cards().length || 5;
    centerIndex = positiveModulo(centerIndex + direction, length);
    applyDefaultSlots(strip);
    dispatchRuntimeEvent("catalog_cycle", { source: source || "manual", center_index: centerIndex });
  }
  function attachRollingDrag(zone, strip) {
    let dragging = false;
    let startX = 0;
    let latestDelta = 0;
    zone.addEventListener("pointerdown", function (event) {
      if (locked || strip.classList.contains("is-track")) return;
      dragging = true;
      startX = event.clientX;
      latestDelta = 0;
      strip.style.transition = "none";
      if (zone.setPointerCapture) zone.setPointerCapture(event.pointerId);
    });
    zone.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      latestDelta = event.clientX - startX;
      const rawFeedback = latestDelta * rollConfig.drag_feedback_ratio;
      const feedback = Math.max(-rollConfig.drag_feedback_limit_px, Math.min(rollConfig.drag_feedback_limit_px, rawFeedback));
      strip.style.transform = "translate3d(" + feedback + "px, 0, 0)";
    });
    function releaseDrag(event) {
      if (!dragging) return;
      dragging = false;
      strip.style.transition = "";
      strip.style.transform = "translate3d(0, 0, 0)";
      if (Math.abs(latestDelta) >= rollConfig.drag_threshold_px) {
        rotateDefaultCards(latestDelta < 0 ? 1 : -1, "drag");
        dispatchRuntimeEvent("catalog_drag", { direction: latestDelta < 0 ? "next" : "previous", distance_px: Math.round(latestDelta) });
      }
      scheduleAutoCycle(rollConfig.manual_resume_delay_ms);
      if (zone.releasePointerCapture && event && event.pointerId) {
        try { zone.releasePointerCapture(event.pointerId); } catch (_) {}
      }
    }
    zone.addEventListener("pointerup", releaseDrag);
    zone.addEventListener("pointercancel", releaseDrag);
  }
  function playRollingCardStrip() {
    const drawButton = document.getElementById("draw_button");
    if (locked) return;
    locked = true;
    pendingResult = null;
    pendingRequestId = "client_req_" + (++requestCounter);
    stopAutoCycle();
    if (drawButton) drawButton.disabled = true;
    dispatchRuntimeEvent("draw_click", { draw_type: "single", request_id: pendingRequestId });
  }
  function receiveRuntimeMessage(message) {
    if (!message || message.type !== "draw_result") return;
    if (message.request_id && pendingRequestId && message.request_id !== pendingRequestId) return;
    pendingResult = message;
    dispatchRuntimeEvent("draw_result", { request_id: pendingRequestId, payload: message.payload || {} });
    const zone = document.getElementById("rolling_card_zone");
    const strip = document.getElementById("rolling_card_strip");
    if (!zone || !strip) {
      dispatchRuntimeEvent("error", { code: "ROLLING_STRIP_MISSING", request_id: pendingRequestId });
      resetRollingCardStrip();
      return;
    }
    zone.classList.add("is-aligning");
    window.setTimeout(function () {
      zone.classList.remove("is-aligning");
      const resultPayload = asRecord(message.payload);
      dispatchRuntimeEvent("flatten_complete", { request_id: pendingRequestId, round_id: String(resultPayload.round_id || "") });
      startRollingTrack(zone, strip, message);
    }, rollConfig.draw_align_ms + rollConfig.draw_align_pause_ms);
  }
  function winnerFromResult(message) {
    const payload = asRecord(message.payload);
    const items = Array.isArray(payload.items) ? payload.items : [];
    const first = asRecord(items[0]);
    const cardList = cards();
    const fallback = cardList[0] || { gift_id: "gift_1", display_label: "奖品" };
    const giftId = String(first.gift_id || fallback.gift_id || "gift_1");
    const index = Math.max(0, cardList.findIndex(function (card, cardIndex) { return giftIdFor(card, cardIndex) === giftId; }));
    const card = cardList[index] || fallback;
    return {
      round_id: String(payload.round_id || ""),
      draw_type: String(payload.draw_type || "single"),
      gift_id: giftIdFor(card, index),
      display_value: String(first.display_value || first.name || labelFor(card, index)),
      rarity: String(first.rarity || rarityForIndex(index, cardList.length)),
      index: index,
      card: card,
      items: items
    };
  }
  function startRollingTrack(zone, strip, message) {
    const cardList = cards();
    const winner = winnerFromResult(message);
    const rollVariants = rollConfig.roll_variants;
    const variant = Number(rollVariants[0] || 22);
    const prePadding = rollConfig.pre_padding_count;
    const targetIndex = prePadding + variant;
    const focus_index = targetIndex;
    const tailPadding = Number(rollConfig.tail_padding_count || 6);
    const totalCards = tailPadding === 6 ? focus_index + 6 : focus_index + tailPadding;
    const zoneWidth = zone.getBoundingClientRect().width || 360;
    const slots = asRecord(layoutGroup.slots);
    const viewport = asRecord(slots.card_strip_viewport);
    const lane = asRecord(asRecord(layoutGroup).roll_lane);
    const scale = zoneWidth / numberValue(viewport.w, 750);
    const cardWidth = Math.max(68, Math.round(numberValue(lane.card_w, 139) * scale));
    const step = Math.max(cardWidth + 7, Math.round(rollConfig.roll_step_px * scale));
    const baseX = Math.round(numberValue(lane.x_base, 14) * scale);
    const endX = -variant * step;
    const rendered = [];
    for (let trackIndex = 0; trackIndex < totalCards; trackIndex += 1) {
      const catalogIndex = trackIndex === targetIndex ? winner.index : positiveModulo(trackIndex - targetIndex + winner.index, cardList.length);
      const card = trackIndex === targetIndex ? winner.card : cardList[catalogIndex];
      rendered.push(renderCard(card, catalogIndex, {
        giftId: giftIdFor(card, catalogIndex),
        rarity: trackIndex === targetIndex ? winner.rarity : rarityForIndex(catalogIndex, cardList.length),
        trackIndex: trackIndex,
        trackX: baseX + trackIndex * step
      }));
    }
    strip.innerHTML = rendered.join("");
    strip.classList.add("is-track");
    strip.style.setProperty("--track-card-width", cardWidth + "px");
    strip.style.transition = "none";
    strip.style.transform = "translate3d(0px, 0, 0)";
    zone.classList.add("is-rolling");
    dispatchRuntimeEvent("roll_start", { request_id: pendingRequestId, round_id: winner.round_id, focus_gift_id: winner.gift_id });
    window.requestAnimationFrame(function () {
      strip.style.transition = "transform " + rollConfig.roll_duration_ms + "ms " + rollConfig.roll_easing;
      strip.style.transform = "translate3d(" + endX + "px, 0, 0)";
    });
    window.setTimeout(function () {
      revealRollingWinner(strip, targetIndex, winner);
    }, rollConfig.roll_duration_ms + 80);
  }
  function revealRollingWinner(strip, targetIndex, winner) {
    const card = strip.querySelector('[data-track-index="' + targetIndex + '"]');
    const scales = rollConfig.reveal_scales || {};
    const winningScale = numberValue(scales[winner.rarity], 1.24);
    if (card) {
      card.classList.add("is-winning", "winning-reveal");
      card.style.setProperty("--winning-scale", String(winningScale));
    }
    window.setTimeout(function () {
      dispatchRuntimeEvent("roll_complete", {
        request_id: pendingRequestId,
        round_id: winner.round_id,
        focus_gift_id: winner.gift_id,
        draw_type: winner.draw_type,
        items: winner.items,
        display_value: winner.display_value
      });
    }, 740);
  }
  function resetRollingCardStrip() {
    const zone = document.getElementById("rolling_card_zone");
    const strip = document.getElementById("rolling_card_strip");
    const drawButton = document.getElementById("draw_button");
    if (!zone || !strip) return;
    locked = false;
    pendingRequestId = "";
    pendingResult = null;
    if (drawButton) drawButton.disabled = false;
    renderDefaultStrip(zone, strip);
    scheduleAutoCycle(rollConfig.auto_cycle_ms);
  }
  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }
  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (id === "draw_result_modal") resetRollingCardStrip();
  }
  function slot(name) {
    const slots = asRecord(layoutGroup.slots);
    return asRecord(slots[name]);
  }
  function applySlotGeometry(element, slotName) {
    const slotConfig = slot(slotName);
    if (!element || !Number.isFinite(Number(slotConfig.w))) return;
    element.style.left = (numberValue(slotConfig.x, 0) / 750 * 100) + "%";
    element.style.top = (numberValue(slotConfig.y, 0) / 1334 * 100) + "%";
    element.style.width = (numberValue(slotConfig.w, 0) / 750 * 100) + "%";
    element.style.height = (numberValue(slotConfig.h, 0) / 1334 * 100) + "%";
    element.style.right = "auto";
    element.style.bottom = "auto";
    if (slotConfig.z !== undefined) element.style.zIndex = String(slotConfig.z);
  }
  window.CampaignRollingCardStrip = {
    send: receiveRuntimeMessage,
    reset: resetRollingCardStrip,
    getImplementationPack: function () { return pack; }
  };
  window.addEventListener("message", function (event) {
    if (event && event.data && event.data.type) receiveRuntimeMessage(event.data);
  });
  document.addEventListener("campaign_host_message", function (event) {
    receiveRuntimeMessage(event.detail);
  });
  document.addEventListener("DOMContentLoaded", function () {
    const drawButton = document.getElementById("draw_button");
    const ruleButton = document.getElementById("rule_button");
    const zone = document.getElementById("rolling_card_zone");
    const strip = document.getElementById("rolling_card_strip");
    applySlotGeometry(zone, "card_strip_viewport");
    applySlotGeometry(drawButton, "draw_button");
    applySlotGeometry(ruleButton, "rule_button");
    if (zone && strip) {
      renderDefaultStrip(zone, strip);
      attachRollingDrag(zone, strip);
      scheduleAutoCycle(rollConfig.initial_auto_cycle_delay_ms);
    }
    if (drawButton) drawButton.addEventListener("click", playRollingCardStrip);
    if (ruleButton) ruleButton.addEventListener("click", function () {
      openModal("rule_modal");
      dispatchRuntimeEvent("rule_modal_open", {});
    });
    document.querySelectorAll("[data-close-modal]").forEach(function (button) {
      button.addEventListener("click", function () {
        closeModal(button.getAttribute("data-close-modal"));
      });
    });
    dispatchRuntimeEvent("runtime_ready", {
      animation_family: pack.animation_family || "rolling_card_strip",
      master_pack_version: pack.master_pack_version
    });
  });
})();
(function () {
  const config = window.__CAMPAIGN_PREVIEW_CONFIG__ || {};
  if (config.env !== "sandbox") return;
  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function firstCard() {
    const pack = window.__CAMPAIGN_IMPLEMENTATION_PACK__ || {};
    const sprites = asRecord(pack.sprites);
    const cards = Array.isArray(sprites.cards) ? sprites.cards : [];
    return asRecord(cards[0] || { gift_id: "gift_1", display_label: "奖品", id: "gift_1_card" });
  }
  function dispatchHostMessage(message) {
    if (window.CampaignRollingCardStrip && typeof window.CampaignRollingCardStrip.send === "function") {
      window.CampaignRollingCardStrip.send(message);
    } else {
      document.dispatchEvent(new CustomEvent("campaign_host_message", { detail: message }));
    }
  }
  function sendDrawResult(runtimeEvent) {
    const payload = asRecord(runtimeEvent.payload);
    const card = firstCard();
    const giftId = String(card.gift_id || "gift_1");
    dispatchHostMessage({
      type: "draw_result",
      request_id: payload.request_id,
      payload: {
        round_id: "sandbox_round_" + String(payload.request_id || "1"),
        draw_type: "single",
        items: [{
          draw_index: 1,
          gift_id: giftId,
          name: String(card.display_label || giftId),
          display_value: String(card.display_label || giftId),
          value: 0,
          rarity: "legendary",
          result_image_id: giftId
        }]
      }
    });
  }
  function openSandboxResult(payload) {
    const resultText = document.getElementById("draw_result_text");
    const resultCode = document.getElementById("draw_result_code");
    const items = Array.isArray(payload.items) ? payload.items : [];
    const item = asRecord(items[0]);
    const giftId = String(payload.focus_gift_id || item.gift_id || "gift_1");
    if (resultText) resultText.textContent = "获得 " + String(payload.display_value || item.display_value || giftId) + "，预览环境不发放真实权益。";
    if (resultCode) resultCode.textContent = giftId;
    const modal = document.getElementById("draw_result_modal");
    if (modal) {
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
    }
    document.dispatchEvent(new CustomEvent("campaign_runtime_event", { detail: { type: "result_popup_open", payload: payload } }));
  }
  window.__CAMPAIGN_SANDBOX_HOST__ = {
    sendDrawResult: sendDrawResult,
    openSandboxResult: openSandboxResult
  };
  document.addEventListener("campaign_runtime_event", function (event) {
    const detail = asRecord(event.detail);
    if (detail.type === "draw_click") {
      window.setTimeout(function () { sendDrawResult(detail); }, 120);
    }
    if (detail.type === "roll_complete") {
      openSandboxResult(asRecord(detail.payload));
    }
  });
})();