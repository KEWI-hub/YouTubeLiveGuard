// Runs in the page's MAIN world so it can use YouTube's player API
// (getProgressState, getStatsForNerds, seekToLiveHead, quality control).
(() => {
  if (window.__ytLiveGuard) return;
  window.__ytLiveGuard = true;

  const SRC_MAIN = 'ytlg-main';
  const SRC_ISO = 'ytlg-iso';
  const TICK_MS = 500;
  const JUMP_SETTLE_MS = 4000;   // หลังเด้ง LIVE ให้เวลาโหลดก่อนตัดสินว่ากระตุกอีก
  const USER_INPUT_WINDOW = 1500;

  let settings = {
    enabled: true, autoJumpOnStall: true, stallSeconds: 2, frequentStalls: 3,
    autoJumpOnLatency: true, maxLatency: 30, autoLowerQuality: false,
    showOverlay: true, cooldown: 8
  };

  const QUALITY_LABEL = {
    highres: '4320p', hd2880: '2880p', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
    hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto'
  };
  // Mbps ที่แนะนำโดยประมาณต่อความละเอียด
  const NEED_MBPS = { hd2160: 20, hd1440: 10, hd1080: 5, hd720: 2.5, large: 1.1, medium: 0.7, small: 0.4, tiny: 0.2 };

  const st = {
    video: null, videoId: null,
    lastTime: -1, lastProgressAt: 0, stallStart: 0,
    stallEvents: [], jumpEvents: [], log: [],
    lastJumpAt: 0, settleUntil: 0, ourSeekUntil: 0,
    lastUserInputAt: 0, userDvr: false,
    dropPrev: null, dropRate: 0, lastQualityDropAt: 0, tickCount: 0
  };

  const post = (type, data) => window.postMessage({ src: SRC_MAIN, type, data }, location.origin);
  const safe = (fn, fb = null) => { try { const r = fn(); return r == null ? fb : r; } catch { return fb; } };
  const getPlayer = () => document.getElementById('movie_player');
  const getVideo = (p) => (p && p.querySelector('video.html5-main-video')) || null;
  const recent = (arr, ms) => arr.filter((t) => Date.now() - t < ms).length;

  function log(msg) {
    st.log.unshift({ t: Date.now(), msg });
    st.log.length = Math.min(st.log.length, 20);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.src !== SRC_ISO) return;
    const { type, data } = e.data;
    if (type === 'settings') settings = { ...settings, ...data };
    else if (type === 'jump') jumpToLive('manual');
    else if (type === 'lower') lowerQuality('manual');
    else if (type === 'autoQuality') setAutoQuality();
  });

  // Track user interaction so a manual rewind (DVR) isn't fought by the latency rule.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#movie_player')) st.lastUserInputAt = performance.now();
  }, true);
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && !e.target.isContentEditable) st.lastUserInputAt = performance.now();
  }, true);

  function attach(v) {
    st.video = v;
    st.dropPrev = null;
    v.addEventListener('seeking', () => {
      const now = performance.now();
      if (now < st.ourSeekUntil) return;
      if (now - st.lastUserInputAt < USER_INPUT_WINDOW) st.userDvr = true;
    });
  }

  function resetForNewVideo(id) {
    st.videoId = id;
    st.stallEvents = []; st.jumpEvents = []; st.stallStart = 0;
    st.userDvr = false; st.dropPrev = null; st.dropRate = 0;
    st.log = [];
  }

  // ---------- measurements ----------
  function liveInfo(p) {
    const ps = safe(() => p.getProgressState());
    if (!ps || !isFinite(ps.seekableEnd) || !isFinite(ps.current)) return { latency: null, atHead: null };
    return { latency: Math.max(0, ps.seekableEnd - ps.current), atHead: !!ps.isAtLiveHead };
  }

  function bufferAhead(v) {
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.1 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
    }
    return 0;
  }

  function updateDropRate(v) {
    const q = safe(() => v.getVideoPlaybackQuality());
    if (!q) return;
    if (st.dropPrev) {
      const dt = q.totalVideoFrames - st.dropPrev.total;
      const dd = q.droppedVideoFrames - st.dropPrev.dropped;
      if (dt > 0) st.dropRate = st.dropRate * 0.6 + (dd / dt) * 0.4;
    }
    st.dropPrev = { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
  }

  const num = (s) => { const n = parseFloat(String(s || '').replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };

  // ---------- actions ----------
  function jumpToLive(reason) {
    const p = getPlayer(); const v = getVideo(p);
    if (!p || !v) return false;
    const now = performance.now();
    if (reason !== 'manual' && now - st.lastJumpAt < settings.cooldown * 1000) return false;

    st.lastJumpAt = now;
    st.settleUntil = now + JUMP_SETTLE_MS;
    st.ourSeekUntil = now + 2000;
    st.stallStart = 0;
    st.userDvr = false;
    st.jumpEvents.push(Date.now());

    // เหมือนกดปุ่ม "LIVE" บนเครื่องเล่น; ถ้าไม่มีปุ่มใช้ API ของ player แทน
    // ถ้าค้างทั้งที่อยู่ Live Now อยู่แล้ว การกดปุ่มอาจไม่มีผล -> สั่ง seek ใหม่เพื่อล้างบัฟเฟอร์ที่ค้าง
    const badge = p.querySelector('.ytp-live-badge');
    // (ปุ่มยังกดได้แม้แถบควบคุมซ่อนอยู่ จึงไม่เช็คว่ามองเห็นหรือไม่)
    if (badge && !liveInfo(p).atHead) badge.click();
    else safe(() => p.seekToLiveHead());
    if (v.paused) v.play().catch(() => {});

    const why = { stall: 'ไลฟ์ค้าง/กระตุก', frequent: 'กระตุกบ่อย', latency: 'หลุดจาก Live Now', manual: 'กดเอง' }[reason] || reason;
    log(`⚡ เด้งกลับ LIVE (${why})`);
    toast(p, `⚡ ${why} → เด้งกลับ LIVE แล้ว`);

    // เด้งแล้วยังกระตุกซ้ำหลายรอบ = เน็ตไม่พอ -> ลดความละเอียด
    if (reason !== 'manual' && settings.autoLowerQuality && recent(st.jumpEvents, 120000) >= 3 &&
        now - st.lastQualityDropAt > 60000) {
      lowerQuality('auto');
    }
    return true;
  }

  function lowerQuality(reason) {
    const p = getPlayer(); if (!p) return;
    const levels = (safe(() => p.getAvailableQualityLevels(), [])).filter((q) => q !== 'auto');
    const cur = safe(() => p.getPlaybackQuality());
    const idx = levels.indexOf(cur);
    const next = levels[idx < 0 ? 0 : idx + 1];
    if (!next || next === cur) { log('ความละเอียดต่ำสุดแล้ว'); return; }
    safe(() => p.setPlaybackQualityRange(next, next));
    safe(() => p.setPlaybackQuality(next));
    st.lastQualityDropAt = performance.now();
    const msg = `ลดความละเอียด ${QUALITY_LABEL[cur] || cur} → ${QUALITY_LABEL[next] || next}` + (reason === 'auto' ? ' (อัตโนมัติ)' : '');
    log(msg); toast(p, '📉 ' + msg);
  }

  function setAutoQuality() {
    const p = getPlayer(); if (!p) return;
    safe(() => p.setPlaybackQualityRange('auto', 'auto'));
    safe(() => p.setPlaybackQuality('auto'));
    log('ตั้งความละเอียดเป็น Auto'); toast(p, 'ความละเอียด: Auto');
  }

  // ---------- main loop ----------
  function tick() {
    st.tickCount++;
    const p = getPlayer(); const v = getVideo(p);
    if (!p || !v) { removeOverlay(); return; }
    if (v !== st.video) attach(v);

    const data = safe(() => p.getVideoData(), {});
    if (data.video_id && data.video_id !== st.videoId) resetForNewVideo(data.video_id);

    const live = !!data.isLive;
    if (!settings.enabled || !live) { removeOverlay(); post('stats', { live, enabled: settings.enabled }); return; }

    const now = performance.now();
    const ad = p.classList.contains('ad-showing');
    const { latency, atHead } = liveInfo(p);

    if (ad || v.paused || v.ended) {
      st.lastTime = v.currentTime; st.lastProgressAt = now; endStall(now);
    } else if (v.currentTime !== st.lastTime) {
      st.lastTime = v.currentTime; st.lastProgressAt = now; endStall(now);
    } else if (now - st.lastProgressAt > 700 && now > st.settleUntil) {
      if (!st.stallStart) {
        st.stallStart = st.lastProgressAt;
        st.stallEvents.push(Date.now());
        log('⏳ ไลฟ์ค้าง (บัฟเฟอร์)');
      }
      if (settings.autoJumpOnStall && now - st.stallStart >= settings.stallSeconds * 1000) jumpToLive('stall');
    }

    if (latency != null && !ad && !v.paused) {
      if (st.userDvr && latency <= settings.maxLatency) st.userDvr = false;
      if (settings.autoJumpOnLatency && !st.userDvr && !st.stallStart && now > st.settleUntil &&
          latency > settings.maxLatency) jumpToLive('latency');
    }

    if (st.tickCount % 2 === 0) report(p, v, data, latency, atHead, ad);
  }

  function endStall(now) {
    if (!st.stallStart) return;
    const dur = (now - st.stallStart) / 1000;
    st.stallStart = 0;
    log(`✔ เล่นต่อได้ (ค้าง ${dur.toFixed(1)} วิ)`);
    if (settings.autoJumpOnStall && recent(st.stallEvents, 60000) >= settings.frequentStalls) {
      st.stallEvents = [];
      jumpToLive('frequent');
    }
  }

  // ---------- diagnosis ----------
  function report(p, v, data, latency, atHead, ad) {
    updateDropRate(v);
    const nerds = safe(() => p.getStatsForNerds(), {});
    const buf = bufferAhead(v);
    const bwMbps = num(nerds.bandwidth_kbps) != null ? num(nerds.bandwidth_kbps) / 1000 : null;
    const quality = safe(() => p.getPlaybackQuality(), '');
    const stalls1m = recent(st.stallEvents, 60000);
    const jumps2m = recent(st.jumpEvents, 120000);
    const stalling = !!st.stallStart;

    let score = 100;
    score -= Math.min(45, stalls1m * 15);
    if (stalling) score -= 30;
    if (buf < 1) score -= 20; else if (buf < 2.5) score -= 8;
    if (st.dropRate > 0.1) score -= 25; else if (st.dropRate > 0.03) score -= 10;
    if (latency != null && latency > settings.maxLatency) score -= 15;
    score = Math.max(0, score);
    const level = score >= 80 ? 'good' : score >= 50 ? 'fair' : 'poor';

    const issues = [];
    const need = NEED_MBPS[quality];
    if (stalling || stalls1m >= 2) {
      issues.push({
        level: 'poor', title: `ไลฟ์กระตุก ${stalls1m} ครั้ง/นาที` + (buf < 1.5 ? ' (บัฟเฟอร์ต่ำ)' : ''),
        fix: buf < 1.5
          ? 'เน็ตโหลดภาพไม่ทัน: ลดความละเอียด 1 ขั้น, ปิดโปรแกรม/แท็บที่ดาวน์โหลดอยู่, ใช้สาย LAN หรือขยับใกล้เราเตอร์'
          : 'บัฟเฟอร์ยังพอแต่ภาพค้าง: อาจเป็นปัญหาต้นทางผู้สตรีม ลองกด LIVE หรือรีเฟรชหน้า',
        action: buf < 1.5 ? 'lower' : 'jump'
      });
    }
    if (bwMbps != null && need && bwMbps < need * 1.5) {
      issues.push({
        level: 'fair', title: `ความเร็วเน็ต ~${bwMbps.toFixed(1)} Mbps ต่ำสำหรับ ${QUALITY_LABEL[quality]}`,
        fix: `ควรมีอย่างน้อย ~${(need * 1.5).toFixed(1)} Mbps สำหรับความละเอียดนี้ — ลดความละเอียดลง`,
        action: 'lower'
      });
    }
    if (st.dropRate > 0.05) {
      issues.push({
        level: st.dropRate > 0.1 ? 'poor' : 'fair', title: `เฟรมตก ${(st.dropRate * 100).toFixed(1)}%`,
        fix: 'เครื่องถอดรหัสภาพไม่ทัน: เปิด Hardware acceleration (chrome://settings/system), ปิดแท็บ/โปรแกรมหนักๆ, หรือลดความละเอียด/60fps',
        action: 'lower'
      });
    }
    if (latency != null && latency > settings.maxLatency) {
      issues.push({
        level: 'fair', title: `ช้ากว่า Live ${latency.toFixed(0)} วินาที` + (st.userDvr ? ' (คุณย้อนดูเอง)' : ''),
        fix: 'กด LIVE เพื่อกลับไปที่ Live Now', action: 'jump'
      });
    }
    if (jumps2m >= 3) {
      issues.push({
        level: 'poor', title: `เด้งกลับ LIVE ไป ${jumps2m} ครั้งใน 2 นาทีแต่ยังกระตุก`,
        fix: 'ถ้าเน็ตแรงแต่ยังกระตุก และคนในแชทก็บ่น = ต้นทางผู้สตรีมมีปัญหา; ถ้าไม่ใช่ ให้ลดความละเอียดหรือเปิด "ลดความละเอียดอัตโนมัติ"',
        action: 'lower'
      });
    }

    const stats = {
      live: true, enabled: true, ad, level, score, stalling,
      title: data.title || '', videoId: data.video_id,
      quality: QUALITY_LABEL[quality] || quality, height: v.videoHeight, width: v.videoWidth,
      resolution: nerds.resolution || '', liveMode: nerds.live_mode || '',
      buffer: buf, latency, atHead, userDvr: st.userDvr,
      dropRate: st.dropRate, bandwidthMbps: bwMbps,
      stalls1m, jumps2m, jumpsTotal: st.jumpEvents.length,
      issues, log: st.log.slice(0, 10), settings
    };
    post('stats', stats);
    renderOverlay(p, stats);
  }

  // ---------- on-player UI ----------
  const COLORS = { good: '#2ecc71', fair: '#f1c40f', poor: '#e74c3c' };
  const LEVEL_TH = { good: 'ดี', fair: 'พอใช้', poor: 'แย่' };

  function removeOverlay() {
    const el = document.getElementById('ytlg-overlay');
    if (el) el.remove();
  }

  function renderOverlay(p, s) {
    if (!settings.showOverlay) { removeOverlay(); return; }
    let el = document.getElementById('ytlg-overlay');
    if (!el || el.parentElement !== p) {
      if (el) el.remove();
      el = document.createElement('div');
      el.id = 'ytlg-overlay';
      el.style.cssText = 'position:absolute;left:12px;bottom:64px;z-index:60;pointer-events:none;' +
        'font:500 12px/1.4 Roboto,Arial,sans-serif;color:#fff;background:rgba(0,0,0,.62);' +
        'padding:3px 9px;border-radius:6px;white-space:nowrap;';
      p.appendChild(el);
    }
    // YouTube บังคับ Trusted Types -> ห้ามใช้ innerHTML ต้องสร้าง DOM เอง
    const dot = colored('●', COLORS[s.level]);
    const text = [
      ` ${LEVEL_TH[s.level]}`,
      s.quality,
      `buf ${s.buffer.toFixed(1)}s`,
      s.latency != null ? `ห่าง Live ${s.latency.toFixed(1)}s` : null,
      `เฟรมตก ${(s.dropRate * 100).toFixed(1)}%`
    ].filter(Boolean).join(' · ');
    el.replaceChildren(dot, text);
    if (s.stalling) el.append(' · ', colored('กำลังค้าง…', COLORS.poor));
  }

  function colored(text, color) {
    const b = document.createElement('b');
    b.style.color = color;
    b.textContent = text;
    return b;
  }

  function toast(p, text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:61;' +
      'pointer-events:none;font:600 14px/1.4 Roboto,Arial,sans-serif;color:#fff;background:rgba(204,0,0,.9);' +
      'padding:6px 14px;border-radius:18px;transition:opacity .4s;';
    p.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2200);
    setTimeout(() => el.remove(), 2700);
  }

  setInterval(tick, TICK_MS);
  post('hello');
})();
