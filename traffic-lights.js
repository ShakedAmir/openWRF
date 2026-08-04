(function () {
  // ===== CONFIG =========================================================
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw6tKaESa-vQd7AkdbjyKoYvmmTTsNzG_dYecXUhv7f6hOpANldJR1sQ4zZdZ5Am_R94A/exec";

  const CFG = {
    med:        { lat: 32.40, lon: 34.25 },   // נקודה בים התיכון (כמו Windy של KDI)
    favDir:     [170, 290],                   // דרום→מערב (מעלות, מטאורולוגי)
    gustFile:   "18z_1km_Kineret_Diamond.csv",
    gustMinKts: 20,
    tempDiffMin: 4,
    // טבלת רונן זוהר: הפרש טמפ' (10:30) → אחוז סיכוי לשעתיים גלישה
    ronen: [[3.5,65],[4,69],[4.5,74],[5,80],[5.5,84]]
  };
  // ======================================================================

  const $ = (id) => document.getElementById(id);
  const root = $("go");

  const compass = (d) => {
    const dirs = ["צפון","צ-מז","מזרח","ד-מז","דרום","ד-מע","מערב","צ-מע"];
    return dirs[Math.round(((d % 360) / 45)) % 8];
  };
  const inRange = (d, [a, b]) => { d = ((d % 360) + 360) % 360; return d >= a && d <= b; };

  function omCurrent(pt, params) {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + pt.lat +
      "&longitude=" + pt.lon + "&current=" + params +
      "&wind_speed_unit=kn&timezone=auto";
    return fetch(url).then(r => r.json());
  }

  function fetchGustMax() {
    const url = APPS_SCRIPT_URL + "?name=" + encodeURIComponent(CFG.gustFile);
    return fetch(url).then(r => r.text()).then(txt => {
      if (!txt || txt.startsWith("Error")) return null;
      const lines = txt.trim().split(/\r?\n/);
      let max = -Infinity, at = "";
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(",");
        const g = parseFloat(c[3]);           // עמודה 4 = Gusts
        if (!isNaN(g) && g > max) { max = g; at = c[0]; }
      }
      return isFinite(max) ? { max, at } : null;
    }).catch(() => null);
  }

  const ICON = { pass: ["pass","✓"], fail: ["fail","✕"], warn: ["warn","!"], unk: ["unk","?"] };

  function setLight(state, label, sub) {
    root.classList.remove("is-go","is-no","is-wait");
    root.classList.add(state);
    $("go-label").textContent = label;
    $("go-sub").textContent = sub || "";
  }

  function fetchIMS(which) {
    return fetch(APPS_SCRIPT_URL + "?ims=" + which)
      .then(r => r.json())
      .then(j => (j && typeof j.temp === "number") ? j : null)
      .catch(() => null);
  }

  // התאמת פרבולה (least-squares) לטבלת רונן זוהר -> אחוז סיכוי לפי הפרש
  const QUAD = fitQuad(CFG.ronen);
  function fitQuad(pts) {
    let n = pts.length, Sx=0,Sx2=0,Sx3=0,Sx4=0,Sy=0,Sxy=0,Sx2y=0;
    pts.forEach(([x,y]) => { const x2=x*x;
      Sx+=x; Sx2+=x2; Sx3+=x2*x; Sx4+=x2*x2; Sy+=y; Sxy+=x*y; Sx2y+=x2*y; });
    return solve3([[Sx4,Sx3,Sx2,Sx2y],[Sx3,Sx2,Sx,Sxy],[Sx2,Sx,n,Sy]]);
  }
  function solve3(M) {
    for (let i=0;i<3;i++){
      const pv=M[i][i];
      for (let k=i;k<4;k++) M[i][k]/=pv;
      for (let r=0;r<3;r++) if (r!==i){ const f=M[r][i]; for (let k=i;k<4;k++) M[r][k]-=f*M[i][k]; }
    }
    return [M[0][3], M[1][3], M[2][3]];
  }
  function probFromDiff(d) {
    const [a,b,c] = QUAD;
    return Math.max(0, Math.min(100, a*d*d + b*d + c));
  }

  function run() {
    setLight("is-wait", "בודק תנאים…", "");
    $("go-checks").innerHTML = "";
    $("go-refresh").disabled = true;

    Promise.all([
      omCurrent(CFG.med, "wind_direction_10m,wind_speed_10m"),
      fetchGustMax(),
      fetchIMS("zemah"),
      fetchIMS("avnei")
    ]).then(([medJ, gust, tzJ, avJ]) => {
      // --- תנאי 1: כיוון רוח בים ---
      let c1 = { state:"unk", title:"רוח דרומית/מערבית בים התיכון", val:"אין נתון" };
      const wdir = medJ && medJ.current ? medJ.current.wind_direction_10m : null;
      const wspd = medJ && medJ.current ? medJ.current.wind_speed_10m : null;
      if (wdir != null) {
        const ok = inRange(wdir, CFG.favDir);
        c1 = { state: ok ? "pass" : "fail", title: c1.title,
               val: "כיוון " + Math.round(wdir) + "° (" + compass(wdir) + ")" +
                    (wspd != null ? " · " + Math.round(wspd) + " קשר" : "") };
      }

      // --- תנאי 2: גאסטים WRF ---
      let c2 = { state:"unk", title:"גאסטים > " + CFG.gustMinKts + " קשר (WRF דיימונד)", val:"אין נתון" };
      if (gust) {
        const ok = gust.max > CFG.gustMinKts;
        c2 = { state: ok ? "pass" : "fail", title: c2.title,
               val: "מקסימום " + Math.round(gust.max) + " קשר" + (gust.at ? " · " + gust.at : "") };
      }

      // --- תנאי 3: הפרש טמפרטורות ---
      let c3 = { state:"unk", title:"הפרש צמח − אבני איתן ≥ " + CFG.tempDiffMin + "°", val:"אין נתון" };
      const tTz = tzJ && typeof tzJ.temp === "number" ? tzJ.temp : null;
      const tAv = avJ && typeof avJ.temp === "number" ? avJ.temp : null;
      let diff = null, prob = null;
      if (tTz != null && tAv != null) {
        diff = tTz - tAv;
        prob = probFromDiff(diff);
        const state = diff >= CFG.tempDiffMin ? "pass" : "warn";
        c3 = { state, title: c3.title,
               val: "צמח " + tTz.toFixed(1) + "° · אבני איתן " + tAv.toFixed(1) +
                    "° · הפרש " + diff.toFixed(1) + "° · סיכוי ~" + Math.round(prob) + "%" };
      }

      // --- תנאי 4: מקום שמור ---
      const c4 = (diff != null)
        ? { state:"pass", title:"ניתוח סטטיסטי", val:"סיכוי לשעתיים גלישה ~" + Math.round(prob) + "%" }
        : { state:"unk", title:"ניתוח סטטיסטי", val:"ממתין לנתוני טמפרטורה" };

      // ציור השורות
      const rows = [c1, c2, c3, c4];
      $("go-checks").innerHTML = rows.map(r => {
        const [cls, ch] = ICON[r.state] || ICON.unk;
        return '<div class="go-check"><span class="go-ic ' + cls + '">' + ch + '</span>' +
          '<span class="go-ctext"><span class="go-ctitle">' + r.title + '</span>' +
          '<span class="go-cval">' + r.val + '</span></span></div>';
      }).join("");

      // --- הכרעה ---
      const known = [c1, c2, c3].every(c => c.state !== "unk");
      const goodAll = c1.state === "pass" && c2.state === "pass" && c3.state === "pass";
      if (!known) {
        setLight("is-no", "לא ניתן לקבוע", "חלק מהנתונים לא נטענו");
      } else if (goodAll) {
        setLight("is-go", "סע לגלוש 🏄",
          prob != null ? ("סיכוי לשעתיים ~" + Math.round(prob) + "% · ") : "כל התנאים מתקיימים");
      } else {
        const missing = [];
        if (c1.state !== "pass") missing.push("רוח");
        if (c2.state !== "pass") missing.push("גאסטים");
        if (c3.state !== "pass") missing.push("הפרש טמפ׳");
        setLight("is-no", "לא לגלוש", "חסר: " + missing.join(", "));
      }

      const now = new Date();
      $("go-time").textContent = "עודכן " + now.toLocaleTimeString("he-IL", {hour:"2-digit", minute:"2-digit"});
      $("go-refresh").disabled = false;
    });
  }

  $("go-refresh").addEventListener("click", run);
  run();
})();
