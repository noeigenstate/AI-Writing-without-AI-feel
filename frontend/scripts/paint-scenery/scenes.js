/* Scene definitions for the offline scenery generator. All coordinates are design units: hero scenes are 800×520.
 * Every scene is original: generic sky, cloud, hill, meadow, forest, cottage, windmill, path. No existing characters or scenes.
 */
(function () {
  const PAL = {
    sap: { s: '#617b3c', m: '#86a14f', l: '#b4c872', r: '#efe2a0', u: '#3d5b3a' },
    olive: { s: '#5a6c3a', m: '#7b904b', l: '#a6b566', r: '#e8da98', u: '#3a5036' },
    moss: { s: '#43613d', m: '#608349', l: '#8aa868', r: '#e0d896', u: '#2e4a37' },
    viridian: { s: '#235c4b', m: '#34806a', l: '#66a98c', r: '#e2e4a6', u: '#16423c' },
    teal: { s: '#21505a', m: '#33736f', l: '#66a493', r: '#dae4ae', u: '#173d47' },
    forest: { s: '#27442f', m: '#386340', l: '#62895a', r: '#d6d890', u: '#183226' },
    haze: { s: '#5d8c78', m: '#79a690', l: '#a1c3aa', r: '#e0e4b0', u: '#4a7766' },
  };
  const SMALL_CLOUD = [[0, 0, 30], [38, -10, 38], [80, 0, 32], [20, -28, 26], [56, -38, 30], [-24, 6, 20], [106, 8, 20]];
  const puffsAt = (x, y, s, base) => (base || SMALL_CLOUD).map(([px, py, r]) => [x + px * s, y + py * s, r * s]);
  const FRAME = 'M52 24H748Q774 24 774 50V470Q774 496 748 496H52Q26 496 26 470V50Q26 24 52 24Z';
  const HW = 1200, HH = 780, HS = 1.5;
  const out = [];

  const push = (name, cv, q, rect) => out.push({ name, q, rect: rect || null, w: cv.width, h: cv.height, dataUrl: cv.toDataURL('image/webp', q) });
  const pushTrim = (name, P, q, pad) => {
    const t = P.trim(pad == null ? 4 : pad);
    if (t) push(name, t.canvas, q, t.rect);
  };

  function grassFringe(name, seed, cols, tall) {
    const P = new Painter(HW, HH, HS, seed);
    P.blades(-10, 810, 524, 18, 46, 90, cols, { seed });
    P.blades(0, 800, 526, 12, 30, 80, [cols[0], cols[1], cols[2]], { seed: seed + 1 });
    if (tall) {
      P.blades(0, 800, 526, 44, 66, 16, [cols[1], cols[2], tall.tip], { seed: seed + 2 });
      P.dabs(tall.flower, 26, 0, 800, 470, 508, 1.7, { seed: seed + 3 });
    }
    pushTrim(name, P, 0.8, 2);
  }

  function lightLayer(name, seed, polys) {
    const P = new Painter(HW, HH, HS, seed);
    P.ctx.filter = 'blur(16px)';
    for (const [pts, a] of polys) {
      const g = P.ctx.createLinearGradient(pts[0][0] * HS, pts[0][1] * HS, pts[2][0] * HS, pts[2][1] * HS);
      g.addColorStop(0, `rgba(255,236,170,${a})`);
      g.addColorStop(1, 'rgba(255,236,170,0)');
      P.ctx.fillStyle = g;
      P.ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? P.ctx.lineTo(x * HS, y * HS) : P.ctx.moveTo(x * HS, y * HS)));
      P.ctx.fill();
    }
    pushTrim(name, P, 0.7, 0);
  }

  function smokeLayer(name, seed, d, width) {
    const P = new Painter(HW, HH, HS, seed);
    P.ctx.filter = 'blur(2.4px)';
    P.strokePath(d, '#fbf6e6', width, { alpha: 0.78, wob: 0.8 });
    pushTrim(name, P, 6, 0);
  }

  // ---------------------------------------------------------------- meadow (rewrite)
  function meadow() {
    const P = new Painter(HW, HH, HS, 11);
    P.fill('#f3ead2');
    // watercolour: sky, light, far hills
    P.wash('M-30 -30H830V372H-30Z', { vgrad: [[0, '#78aed3'], [0.5, '#b0d2e0'], [1, '#f4ecd4']], c2: '#8fbfdc', alpha: 0.96, wob: 4, edge: 0.25, mode: 'over', gradY: [-30, 372], streak: 0.09, var: 0.14, soft: 5 });
    P.sunGlow(110, 40, 300, 220, '#fbe6a8', 0.5);
    P.wash('M-40 300C60 255 140 270 220 285C300 300 360 250 460 262C560 275 640 240 720 262C770 275 800 270 840 280V380H-40Z', { c1: '#b3cbc6', c2: '#a6c2c0', c3: '#bfd4c8', alpha: 0.85, edge: 0.35, mode: 'over' });
    P.wash('M-40 332C80 302 180 312 280 327C380 342 470 304 580 314C680 324 760 302 840 316V400H-40Z', { c1: '#a4c19a', c2: '#b0c9a2', c3: '#98b896', alpha: 0.9, edge: 0.35, mode: 'over' });
    [[610, 312, 6, 24], [624, 310, 6, 20], [740, 304, 6, 22], [756, 306, 5, 18], [60, 318, 6, 20]].forEach(([x, y, rx, ry], i) => P.crown(x, y, rx, ry, PAL.haze, { seed: 300 + i, leaf: 0.3 }));
    P.pencil('M-10 300C60 255 140 270 220 285M460 262C560 275 640 240 720 262', { seed: 1 });
    // gouache: mid hill, fields, hedgerow and trees
    P.gouache('M-40 362C80 336 200 346 300 366C380 382 440 352 520 332C600 314 690 336 840 346V520H-40Z', { vgrad: [[0, '#adc070'], [1, '#8da358']], c2: '#9db266', c3: '#b2c274', gradY: [320, 450], wob: 1.8 });
    P.gouache('M20 398C90 382 170 386 252 400L240 424C160 410 90 408 12 424Z', { c1: '#d4c680', c2: '#c6b872', c3: '#dccf90', wob: 0.8 });
    P.gouache('M252 400C312 394 372 394 424 390L434 420C372 424 312 424 240 424Z', { c1: '#b2c472', c2: '#a4b866', wob: 0.8 });
    P.gouache('M12 424C90 408 160 410 240 424L228 448C150 436 80 436 4 450Z', { c1: '#a5bd68', c2: '#96b05c', c3: '#b3c674', wob: 0.8 });
    P.gouache('M240 424C312 424 372 420 434 420L444 446C380 450 310 452 228 448Z', { c1: '#cdbb7a', c2: '#bfae6e', wob: 0.8 });
    P.strokePath('M16 398C90 382 170 386 252 400C312 394 372 394 424 390M12 424C90 408 160 410 240 424C312 424 372 420 434 420', '#587a43', 1.6, { alpha: 0.7, wob: 0.8 });
    [[40, 396, 11], [66, 392, 13], [96, 388, 11], [152, 392, 12], [200, 396, 10], [276, 396, 12], [304, 392, 11], [336, 390, 13], [372, 390, 11], [404, 388, 12], [24, 424, 10], [120, 414, 12], [236, 424, 11], [330, 422, 10], [420, 420, 11]].forEach(([x, y, r], i) => P.crown(x, y, r, r * 0.8, PAL[i % 3 === 0 ? 'moss' : i % 3 === 1 ? 'sap' : 'olive'], { seed: 100 + i, leaf: 0.2 }));
    P.crown(130, 354, 42, 17, PAL.moss, { seed: 1 });
    P.crown(250, 362, 32, 14, PAL.olive, { seed: 2 });
    P.crown(690, 342, 46, 18, PAL.moss, { seed: 3 });
    P.crown(772, 348, 36, 15, PAL.olive, { seed: 4 });
    // the cottage
    P.sunGlow(546, 322, 40, 40, '#f6cf6c', 0.35);
    P.fillPath('M528 312h58v26h-58z', '#f1e3c1');
    P.fillPath('M560 312h26v26h-26z', '#d6c59e', { alpha: 0.7 });
    P.fillPath('M586 322h18v16h-18z', '#eadab6');
    P.fillPath('M583 324l12-10l12 10z', '#b4573a');
    P.fillPath('M519 315l38-28l38 28z', '#cf6a45');
    P.fillPath('M557 287l38 28h-38z', '#a64d37', { alpha: 0.6 });
    P.strokePath('M521 314L557 288', '#e89a74', 1.2, { alpha: 0.8 });
    P.fillPath('M575 283h8v18h-8z', '#a9553f');
    P.fillPath('M536 319h11v11h-11z', '#f6cf6c');
    P.strokePath('M541.5 319v11M536 324.5h11', '#8a5a3c', 1);
    P.fillPath('M562 338v-11a5 5 0 0 1 10 0v11z', '#8a5a3c');
    // fence, mailbox, clothesline, bicycle
    for (let k = 0; k < 6; k++) P.strokePath(`M${606 + k * 10} 366V354`, '#f1e7d0', 2.6);
    P.strokePath('M604 358H658M604 363H658', '#e3d6b6', 1.4);
    P.strokePath('M580 372v-12', '#7a5a3c', 2);
    P.fillPath('M574 354h13v7h-13z', '#cf6a45');
    P.strokePath('M614 340V316M652 340V318', '#8a7a5a', 1.3);
    P.strokePath('M614 317Q633 326 652 319', '#6f6450', 0.9);
    P.fillPath('M621 321h6v10h-6z', '#fbf4e2');
    P.fillPath('M632 323h6v9h-6z', '#8fb6d0');
    P.fillPath('M643 321h6v8h-6z', '#d98466');
    P.strokePath('M684 376a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M701 376a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M690 376L697 366L707 376M697 366H693', '#5b5547', 1.1);
    // tree and bench
    P.fillPath('M466 346c2-12 1-20-2-30l6 0c-1 10 0 20 4 30z', '#6e5238');
    P.crown(468, 300, 54, 40, PAL.sap, { seed: 5, density: 1.1 });
    P.strokePath('M448 346h26M451 346v8M471 346v8', '#8a5a3c', 2.6);
    P.pencil('M519 315L557 287L595 315M528 312V338', { seed: 2, alpha: 0.5 });
    // foreground
    P.gouache('M-40 440C100 420 260 436 400 452C560 468 700 430 840 440V560H-40Z', { vgrad: [[0, '#93ae5d'], [1, '#7c9a50']], c2: '#88a557', c3: '#9eb868', gradY: [425, 560], wob: 2, streak: 0.09 });
    P.gouache('M-40 486C140 470 300 486 420 496C580 510 700 484 840 490V560H-40Z', { vgrad: [[0, '#7b9852'], [1, '#62803f']], c2: '#6d8b47', gradY: [470, 560], wob: 2, streak: 0.09 });
    P.gouache('M240 520C290 478 400 488 392 448C386 420 470 418 520 392C548 376 550 360 560 346L572 346C566 366 566 380 540 398C500 424 430 432 440 452C450 480 360 500 350 520Z', { vgrad: [[0, '#e9d9ad'], [1, '#dcc896']], c2: '#e2d0a2', wob: 1.6 });
    P.gouache('M240 520C290 478 400 488 392 448C386 420 470 418 520 392C548 376 550 360 560 346L563 347C553 362 551 378 524 396C474 424 394 424 400 452C406 480 300 486 250 520Z', { c1: '#c9b484', c2: '#bda676', alpha: 0.5, wob: 1.6 });
    P.blades(0, 800, 508, 8, 20, 60, ['#4d6e3c', '#6f8f4a', '#9db460'], { seed: 7 });
    P.crown(300, 470, 40, 16, PAL.moss, { seed: 15 });
    P.crown(560, 462, 36, 14, PAL.olive, { seed: 16 });
    P.crown(450, 482, 30, 12, PAL.sap, { seed: 17 });
    P.crown(70, 478, 96, 48, PAL.moss, { seed: 6, density: 1.15 });
    P.crown(180, 508, 74, 30, PAL.sap, { seed: 7 });
    P.crown(730, 484, 96, 54, PAL.sap, { seed: 8, density: 1.15 });
    P.crown(632, 512, 62, 26, PAL.olive, { seed: 9 });
    P.dabs('#f0cd72', 60, 20, 780, 452, 514, 2.5, { seed: 1 });
    P.dabs('#fbf4e2', 60, 20, 780, 450, 514, 2.3, { seed: 2 });
    P.dabs('#d98466', 32, 20, 780, 456, 514, 2.3, { seed: 3 });
    P.dabs('#b6a6cf', 32, 20, 780, 452, 512, 2.2, { seed: 4 });
    P.strokePath('M300 92q5-6 10 0q5-6 10 0M330 78q4-5 8 0q4-5 8 0M356 98q5-5 9 0q5-5 9 0', '#4d5a58', 1.2, { alpha: 0.7 });
    P.finish();
    P.vignette(FRAME);
    push('meadow-bg', P.canvas, 0.74);

    // moving layers
    let C = new Painter(HW, HH, HS, 21);
    C.cumulus(puffsAt(140, 118, 0.95)); C.cumulus(puffsAt(560, 74, 1.1));
    pushTrim('meadow-clouds-far', C, 0.82, 2);
    C = new Painter(HW, HH, HS, 22);
    C.cumulus(puffsAt(330, 192, 1.4));
    pushTrim('meadow-clouds-near', C, 0.82, 2);
    smokeLayer('meadow-smoke', 23, 'M579 281c-6-10 7-16 1-28c-5-9 6-14 2-24', 6);
    lightLayer('meadow-light', 24, [[[[-20, -10], [220, -10], [520, 560], [250, 560]], 0.34], [[[260, -10], [380, -10], [700, 560], [560, 560]], 0.22]]);
    grassFringe('meadow-grass', 25, ['#436a3a', '#6f9048', '#a6bd62'], { tip: '#e0d58f', flower: '#f3e6b0' });
  }

  // ---------------------------------------------------------------- sky (generate)
  function sky() {
    const P = new Painter(HW, HH, HS, 12);
    P.fill('#f3ead2');
    P.wash('M-30 -30H830V392H-30Z', { vgrad: [[0, '#64a2cf'], [0.45, '#98c4de'], [0.85, '#e9e4cc'], [1, '#f3ecd6']], c2: '#86b8d8', alpha: 0.96, wob: 4, edge: 0.2, mode: 'over', gradY: [-30, 392], streak: 0.09, var: 0.16, soft: 5 });
    P.sunGlow(650, 60, 280, 210, '#fbe6a8', 0.45);
    // towering cumulus: painted row by row, bottom first, so each billow overlaps the one below
    P.wash('M110 334C170 322 380 322 430 334C380 346 170 346 110 334Z', { c1: '#b3b4cc', c2: '#a5a9c6', alpha: 0.45, wob: 2 });
    P.cumulus([[150, 310, 60], [225, 318, 70], [310, 312, 62], [385, 318, 48]], { shade: 1.15, soft: 4 });
    P.cumulus([[190, 258, 62], [270, 250, 68], [345, 262, 50]], { shade: 1.1, soft: 4 });
    P.cumulus([[215, 200, 58], [290, 190, 60], [250, 140, 52]], { shade: 1, soft: 4 });
    P.cumulus([[305, 110, 42], [225, 100, 36], [270, 62, 28]], { shade: 0.9, soft: 4 });
    P.cumulus([[600, 190, 34], [640, 176, 40], [684, 190, 32], [630, 158, 28], [664, 162, 24]], { shade: 1 });
    // far hills (watercolour)
    P.wash('M-40 330C60 296 150 306 230 322C310 338 380 306 470 312C570 318 650 292 730 308C780 318 810 312 840 318V400H-40Z', { c1: '#b2cbd0', c2: '#a4c0c8', c3: '#bfd4d0', alpha: 0.88, edge: 0.35, mode: 'over' });
    P.wash('M-40 356C80 330 190 340 300 352C400 362 500 326 600 330C700 334 780 322 840 336V420H-40Z', { c1: '#a8c3a6', c2: '#b4cba8', c3: '#9cbb9c', alpha: 0.9, edge: 0.35, mode: 'over' });
    // village and windmill tower (blades are a separate moving layer)
    [[700, 322], [716, 319], [731, 323], [688, 326], [745, 327]].forEach(([x, y]) => {
      P.fillPath(`M${x - 6} ${y}h12v-8h-12z`, '#f1e5c6');
      P.fillPath(`M${x - 8} ${y - 8}l8-7l8 7z`, '#cf6a45');
    });
    P.fillPath('M633 332l3-34h8l3 34z', '#efe3c8');
    P.fillPath('M634 298l6-9l6 9z', '#b7573b');
    // mid hills
    P.gouache('M-40 392C60 366 170 372 270 392C360 410 450 386 540 372C640 358 740 372 840 384V520H-40Z', { vgrad: [[0, '#acc070'], [1, '#8da358']], c2: '#9db266', c3: '#b4c476', gradY: [358, 470], wob: 1.8 });
    P.crown(90, 382, 38, 18, PAL.moss, { seed: 1 });
    P.crown(330, 394, 32, 14, PAL.olive, { seed: 2 });
    P.crown(560, 378, 34, 15, PAL.moss, { seed: 3 });
    P.crown(760, 386, 38, 16, PAL.olive, { seed: 4 });
    // earth outcrop with grass cap (warm pink-brown)
    P.gouache('M-40 430C0 396 80 384 140 404C190 420 210 440 214 470V520H-40Z', { vgrad: [[0, '#c29a89'], [1, '#a77d6e']], c2: '#b88a7a', c3: '#cba596', gradY: [390, 520], wob: 2, streak: 0.09 });
    P.gouache('M120 404C170 420 210 440 214 470V520H170C176 470 160 430 120 404Z', { c1: '#8d6659', c2: '#9a7061', alpha: 0.6, wob: 1.6 });
    P.gouache('M-40 424C0 392 80 380 142 400C100 396 40 402 -40 436Z', { c1: '#93ad5e', c2: '#86a357', wob: 1.2 });
    P.fillPath('M60 374c2-10 2-16 0-24l5 0c-1 8-1 14 1 24z', '#6e5238');
    P.crown(62, 342, 36, 27, PAL.sap, { seed: 5 });
    P.strokePath('M40 374h22M43 374v7M59 374v7', '#8a5a3c', 2.4);
    // foreground slope and path
    P.gouache('M-40 450C100 436 260 450 400 464C560 478 700 446 840 456V560H-40Z', { vgrad: [[0, '#94ae5e'], [1, '#7d9b51']], c2: '#89a657', gradY: [440, 560], wob: 2, streak: 0.09 });
    P.gouache('M-40 494C140 480 300 494 420 502C580 514 700 492 840 498V560H-40Z', { vgrad: [[0, '#7b9852'], [1, '#62803f']], c2: '#6d8b47', gradY: [480, 560], wob: 2, streak: 0.09 });
    P.gouache('M340 520C390 484 330 462 400 438C470 414 540 408 590 384C612 372 626 364 640 352L650 354C640 368 628 380 606 392C556 418 490 428 440 448C396 464 440 490 410 520Z', { vgrad: [[0, '#e9d9ad'], [1, '#dcc896']], c2: '#e2d0a2', wob: 1.6 });
    P.gouache('M340 520C390 484 330 462 400 438C470 414 540 408 590 384C612 372 626 364 640 352L643 354C628 368 616 378 596 390C540 418 480 428 430 448C386 466 430 492 400 520Z', { c1: '#c9b484', c2: '#bda676', alpha: 0.5, wob: 1.6 });
    P.blades(0, 800, 508, 8, 20, 60, ['#4d6e3c', '#6f8f4a', '#9db460'], { seed: 8 });
    P.crown(110, 502, 110, 46, PAL.moss, { seed: 6, density: 1.15 });
    P.crown(720, 496, 100, 50, PAL.sap, { seed: 7, density: 1.15 });
    P.dabs('#f0cd72', 28, 20, 780, 466, 514, 2.1, { seed: 5 });
    P.dabs('#fbf4e2', 28, 20, 780, 464, 514, 1.9, { seed: 6 });
    P.dabs('#b6a6cf', 16, 20, 780, 466, 514, 1.8, { seed: 7 });
    P.strokePath('M655 150C640 200 700 250 626 332', '#7a7468', 0.7, { alpha: 0.32, wob: 1 });
    P.strokePath('M470 120q5-6 10 0q5-6 10 0M496 106q4-5 8 0q4-5 8 0M520 128q5-5 9 0q5-5 9 0M440 150q3-4 7 0q3-4 7 0', '#4d5a58', 1.2, { alpha: 0.7 });
    P.finish();
    P.vignette(FRAME);
    push('sky-bg', P.canvas, 0.74);

    let C = new Painter(HW, HH, HS, 31);
    C.cumulus(puffsAt(40, 110, 0.8)); C.cumulus(puffsAt(470, 230, 0.9));
    pushTrim('sky-clouds-far', C, 0.82, 2);
    C = new Painter(HW, HH, HS, 32);
    C.cumulus(puffsAt(560, 70, 1.2));
    pushTrim('sky-clouds-near', C, 0.82, 2);
    // windmill blades (rotate about their own centre)
    C = new Painter(HW, HH, HS, 33);
    C.strokePath('M640 298L640 274M640 298L664 298M640 298L640 322M640 298L616 298', '#7d6d50', 1.6);
    C.fillPath('M642 296L642 276L648 276L648 296z', '#f1e5c6');
    C.fillPath('M642 300L662 300L662 306L642 306z', '#f1e5c6');
    C.fillPath('M638 300L638 320L632 320L632 300z', '#f1e5c6');
    C.fillPath('M638 296L618 296L618 290L638 290z', '#f1e5c6');
    pushTrim('sky-windmill', C, 0.85, 2);
    // kite
    C = new Painter(HW, HH, HS, 34);
    C.fillPath('M655 82L677 110L655 152L633 110z', '#d4694a');
    C.fillPath('M655 82L677 110L655 110z', '#b5523a', { alpha: 0.55 });
    C.strokePath('M655 82V152M633 110H677', '#fbf4e2', 1, { alpha: 0.85 });
    C.strokePath('M655 152c-10 12 10 20 0 34c-8 10 8 16 2 28', '#7a7468', 1);
    C.strokePath('M650 170l10 3M652 190l9 4M654 206l8 3', '#d4694a', 3);
    pushTrim('sky-kite', C, 0.85, 2);
    smokeLayer('sky-smoke', 35, 'M722 312c-4-7 5-11 1-19c-3-6 4-9 1-16', 3.4);
    lightLayer('sky-light', 36, [[[[520, -10], [640, -10], [420, 560], [150, 560]], 0.26]]);
    grassFringe('sky-grass', 37, ['#436a3a', '#6f9048', '#a6bd62'], { tip: '#e6dca0', flower: '#f3e6b0' });
  }

  // ---------------------------------------------------------------- forest (novel)
  function forest() {
    const P = new Painter(HW, HH, HS, 13);
    P.fill('#f3ead2');
    P.gouache('M-40 -40H840V560H-40Z', { c1: '#26493c', c2: '#2c5646', c3: '#1f4034', wob: 0, alpha: 1, streak: 0.09, var: 0.2 });
    // the clearing: sky above, mist, warm glow where the path ends (watercolour)
    P.wash('M200 -20C150 60 170 200 230 290C300 340 500 340 570 290C630 200 650 60 600 -20Z', { vgrad: [[0, '#b7d3dd'], [0.5, '#e4eee6'], [0.8, '#eef0d4'], [1, '#f3e6b4']], c2: '#cfe2e0', alpha: 0.98, wob: 6, edge: 0.3, gradY: [-20, 340], soft: 6, streak: 0.06, mode: 'over' });
    P.sunGlow(400, 300, 190, 70, '#f8e6a6', 0.7);
    P.wash('M214 300C240 262 280 276 310 266C340 252 380 270 400 262C430 250 470 270 500 262C530 256 570 272 590 300V332H214Z', { c1: '#8fb59c', c2: '#7fa890', c3: '#a3c4a8', alpha: 0.65, edge: 0.4, mode: 'over' });
    P.wash('M240 318C270 288 310 298 350 290C380 284 420 290 450 288C490 292 530 290 560 318V342H240Z', { c1: '#6f9f86', c2: '#7eac92', alpha: 0.7, edge: 0.4, mode: 'over' });
    P.cumulus(puffsAt(352, 98, 0.9, [[0, 0, 24], [30, -6, 30], [64, 0, 24], [18, -22, 20], [44, -28, 22]]), { shade: 0.8 });
    P.pencil('M232 100C252 40 330 0 400 -2C470 0 550 40 570 100', { seed: 4, alpha: 0.28 });
    // hazy distant trees at the far end of the clearing
    [[262, 304, 30, 26], [304, 296, 26, 24], [346, 300, 30, 24], [452, 298, 30, 24], [498, 300, 28, 26], [540, 306, 30, 26]].forEach(([x, y, rx, ry], i) => P.crown(x, y, rx, ry, PAL.haze, { seed: 200 + i, leaf: 0.2 }));
    // trunks (gouache)
    P.gouache('M160 540c8-120 4-250-10-380h38c-6 130-2 260 14 380z', { vgrad: [[0, '#5a533c'], [1, '#463f2e']], c2: '#4d4733', wob: 1.2, vstreak: true, streak: 0.14, gradY: [140, 540] });
    P.gouache('M176 540c4-120 2-250-6-380h18c-6 130-2 260 14 380z', { c1: '#2f2b1c', c2: '#38331f', alpha: 0.6, wob: 1.2, vstreak: true });
    P.gouache('M628 540c-6-110-2-230 10-340h30c-10 110-8 230-4 340z', { vgrad: [[0, '#5a533c'], [1, '#463f2e']], c2: '#4d4733', wob: 1.2, vstreak: true, streak: 0.14, gradY: [200, 540] });
    P.gouache('M650 540c-4-110 0-230 10-340h8c-10 110-8 230-4 340z', { c1: '#2f2b1c', c2: '#38331f', alpha: 0.6, wob: 1.2, vstreak: true });
    P.strokePath('M168 220c-34-10-60-4-90 14M646 240c30-12 56-8 84 6', '#4d4733', 7);
    // canopy ring around the opening, then the walls (dabbed foliage)
    const rim = [[214, 52, 54, 46, 'sap'], [286, 4, 58, 42, 'viridian'], [360, -10, 60, 34, 'sap'], [446, -10, 60, 34, 'teal'], [520, 6, 58, 42, 'sap'], [590, 50, 54, 46, 'viridian'], [196, 124, 58, 50, 'teal'], [604, 124, 58, 50, 'viridian'], [214, 214, 48, 68, 'forest'], [588, 214, 48, 70, 'teal']];
    rim.forEach(([x, y, rx, ry, p], i) => P.crown(x, y, rx, ry, PAL[p], { seed: 30 + i, density: 1.05 }));
    P.crown(60, 210, 124, 156, PAL.forest, { seed: 41, density: 1.1 });
    P.crown(742, 216, 124, 160, PAL.teal, { seed: 42, density: 1.1 });
    P.crown(130, 108, 92, 72, PAL.viridian, { seed: 43 });
    P.crown(676, 104, 94, 74, PAL.forest, { seed: 44 });
    P.crown(100, 330, 90, 70, PAL.moss, { seed: 45 });
    P.crown(706, 336, 92, 72, PAL.viridian, { seed: 46 });
    // forest floor: layered, dappled, never one flat plane
    P.gouache('M-40 360C100 330 260 340 400 332C540 340 700 330 840 360V560H-40Z', { vgrad: [[0, '#7f9a55'], [0.5, '#6a8548'], [1, '#52703d']], c2: '#6f8c4a', c3: '#8aa65e', gradY: [330, 560], wob: 2.4, streak: 0.09, var: 0.28 });
    P.gouache('M-40 440C120 420 280 432 400 430C540 432 690 418 840 440V560H-40Z', { vgrad: [[0, '#5f7c42'], [1, '#456236']], c2: '#587540', c3: '#6d8b4b', gradY: [420, 560], wob: 2.4, streak: 0.09, var: 0.28 });
    P.gouache('M330 520C380 470 330 432 385 394C420 368 396 336 400 312L408 312C412 340 450 370 430 400C405 440 470 480 480 520Z', { vgrad: [[0, '#eadcb2'], [1, '#d9c595']], c2: '#e2d0a2', wob: 1.4 });
    P.gouache('M330 520C380 470 330 432 385 394C420 368 396 336 400 312L403 312C400 338 424 368 396 398C350 436 400 480 372 520Z', { c1: '#bfaa7c', c2: '#b39e70', alpha: 0.5, wob: 1.4 });
    P.wash('M-40 360C80 350 200 380 220 440C230 500 100 560 -40 560Z', { c1: '#2f4a33', c2: '#37553a', alpha: 0.4, soft: 16, pool: 20, edge: 0.1, wob: 6, softMix: 1 });
    P.wash('M840 360C720 350 600 380 580 440C570 500 700 560 840 560Z', { c1: '#2f4a33', c2: '#37553a', alpha: 0.4, soft: 16, pool: 20, edge: 0.1, wob: 6, softMix: 1 });
    P.wash('M310 340C380 332 440 332 500 340C560 400 640 470 720 530H90C170 470 250 400 310 340Z', { c1: '#f1e8a8', c2: '#e8e09a', alpha: 0.3, soft: 18, pool: 20, edge: 0, wob: 6, mode: 'over', softMix: 1 });
    // dapples of sun and drifts of fallen leaves on the floor
    P.ctx.filter = 'blur(4px)';
    P.dabs('#ecdf9e', 26, 140, 680, 350, 500, 11, { seed: 9, alpha: 0.3 });
    P.ctx.filter = 'none';
    P.dabs('#cfc27c', 40, 90, 700, 360, 520, 2.4, { seed: 10, alpha: 0.7 });
    P.dabs('#8a6a3e', 24, 90, 700, 370, 520, 2, { seed: 14, alpha: 0.6 });
    [[190, 400, 'moss'], [250, 372, 'olive'], [330, 380, 'moss'], [470, 376, 'olive'], [560, 396, 'moss'], [620, 372, 'sap']].forEach(([x, y, p], i) => P.crown(x, y, 22 + (i % 3) * 5, 14 + (i % 2) * 3, PAL[p], { seed: 220 + i, leaf: 0.2 }));
    P.blades(0, 800, 470, 10, 30, 70, ['#2d5438', '#4a7544', '#86a65a'], { seed: 15 });
    // far cottage, bench, lantern
    P.fillPath('M396 307h12v-9h-12z', '#f0e2c0');
    P.fillPath('M393 299l9-8l9 8z', '#cf6a45');
    P.fillPath('M399 301h3v3h-3z', '#f6cf6c');
    P.sunGlow(402, 302, 16, 16, '#f6cf6c', 0.45);
    P.strokePath('M452 436h38M456 436v-10M486 436v-10M452 426h38', '#7a5a3c', 3);
    P.strokePath('M190 232v22', '#5a4a38', 1.5);
    P.fillPath('M184 254h12v16h-12z', '#f6cf6c');
    P.strokePath('M184 254h12M187 270h6', '#6a4a2c', 2);
    P.sunGlow(190, 262, 26, 26, '#f6cf6c', 0.6);
    // undergrowth
    P.crown(70, 474, 104, 52, PAL.forest, { seed: 51, density: 1.2 });
    P.crown(740, 480, 108, 54, PAL.viridian, { seed: 52, density: 1.2 });
    P.crown(250, 510, 72, 26, PAL.moss, { seed: 53 });
    P.crown(560, 512, 82, 28, PAL.sap, { seed: 54 });
    P.dabs('#f0cd72', 14, 250, 560, 470, 512, 2, { seed: 11 });
    P.dabs('#fbf4e2', 12, 240, 570, 468, 514, 1.8, { seed: 12 });
    P.strokePath('M300 60q5-6 10 0q5-6 10 0M326 46q4-5 8 0q4-5 8 0M470 80q5-5 9 0q5-5 9 0', '#4d5a58', 1.2, { alpha: 0.7 });
    P.finish();
    P.vignette(FRAME);
    push('forest-bg', P.canvas, 0.74);

    let C = new Painter(HW, HH, HS, 41);
    C.cumulus(puffsAt(560, 70, 0.8, [[0, 0, 24], [30, -6, 30], [64, 0, 24], [18, -22, 20], [44, -28, 22]]), { shade: 0.8 });
    pushTrim('forest-clouds-far', C, 0.82, 2);
    smokeLayer('forest-smoke', 42, 'M404 292c-3-5 3-8 1-13c-2-4 3-6 1-10', 2.2);
    // light shafts and glints
    C = new Painter(HW, HH, HS, 43);
    C.ctx.filter = 'blur(18px)';
    [[[[330, 60], [430, 60], [330, 560], [120, 560]], 0.5], [[[400, 60], [470, 60], [560, 560], [380, 560]], 0.4], [[[450, 60], [520, 60], [740, 560], [610, 560]], 0.3]].forEach(([pts, a]) => {
      const g = C.ctx.createLinearGradient(400 * HS, 60 * HS, 400 * HS, 560 * HS);
      g.addColorStop(0, `rgba(255,236,170,${a})`);
      g.addColorStop(1, 'rgba(255,236,170,0)');
      C.ctx.fillStyle = g;
      C.ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? C.ctx.lineTo(x * HS, y * HS) : C.ctx.moveTo(x * HS, y * HS)));
      C.ctx.fill();
    });
    C.ctx.filter = 'none';
    C.dabs('#fbe9ae', 24, 200, 620, 330, 500, 3.2, { seed: 13, alpha: 0.5 });
    pushTrim('forest-light', C, 0.72, 0);
    grassFringe('forest-grass', 44, ['#1d4a38', '#2f6149', '#7fa05a'], null);
  }

  // ---------------------------------------------------------------- sidebar: forest edge
  function sidebar() {
    const S2 = 2, SW = 236, SH = 300;
    let P = new Painter(SW * S2, SH * S2, S2, 51);
    P.wash(`M-20 120C40 90 120 106 170 112C210 118 240 100 260 96V${SH + 20}H-20Z`, { c1: '#3b6d5f', c2: '#32604f', alpha: 0.7, edge: 0.4, soft: 4 });
    const t = [[10, 170, 56, 62, 'forest'], [88, 150, 58, 74, 'teal'], [168, 168, 62, 64, 'forest'], [226, 142, 48, 78, 'viridian'], [48, 236, 74, 48, 'moss'], [150, 244, 80, 44, 'forest'], [222, 230, 54, 50, 'moss']];
    t.forEach(([x, y, rx, ry, p], i) => P.crown(x, y, rx, ry, PAL[p], { seed: 60 + i, density: 1.1, leaf: 0.15 }));
    P.gouache(`M-20 ${SH - 26}C50 ${SH - 38} 150 ${SH - 32} 260 ${SH - 44}V${SH + 20}H-20Z`, { vgrad: [[0, '#6f8c4b'], [1, '#52703d']], c2: '#5f7d44', wob: 1.6, gradY: [SH - 46, SH] });
    P.finish({ warp: 0.8 });
    push('sidebar-edge', P.canvas, 0.78);
    P = new Painter(SW * S2, 60 * S2, S2, 52);
    P.blades(-6, 242, 56, 12, 34, 54, ['#2f5a3a', '#4f7a43', '#8dab5a'], { seed: 52 });
    push('sidebar-grass', P.canvas, 0.8);
    P = new Painter(SW * S2, 170 * S2, S2, 53);
    P.crown(214, 6, 84, 44, PAL.forest, { seed: 71, density: 1.1, leaf: 0.15 });
    P.crown(150, -10, 58, 32, PAL.teal, { seed: 72, leaf: 0.15 });
    P.crown(236, 62, 40, 26, PAL.viridian, { seed: 73, leaf: 0.15 });
    P.finish({ warp: 0.8 });
    push('sidebar-leaves', P.canvas, 0.78);
    P = new Painter(SW * S2, SH * S2, S2, 54);
    for (let k = 0; k < 9; k++) {
      const x = 16 + ((k * 61) % 200), y = 120 + ((k * 37) % 150);
      const g = P.ctx.createRadialGradient(x * S2, y * S2, 0, x * S2, y * S2, 7 * S2);
      g.addColorStop(0, 'rgba(255,230,140,0.95)');
      g.addColorStop(1, 'rgba(255,230,140,0)');
      P.ctx.fillStyle = g;
      P.ctx.fillRect((x - 8) * S2, (y - 8) * S2, 16 * S2, 16 * S2);
    }
    push('sidebar-glints', P.canvas, 0.8);
  }

  // ---------------------------------------------------------------- page backdrop
  function backdrop() {
    const BW = 2000, BH = 260;
    let P = new Painter(BW, BH, 1, 61);
    P.wash(`M-20 150C200 110 420 140 700 128C960 116 1240 100 1500 124C1700 140 1860 120 2020 130V${BH + 20}H-20Z`, { c1: '#cdd9a8', c2: '#c3d19e', c3: '#d6dfb4', alpha: 0.85, edge: 0.5, soft: 5, wob: 5 });
    P.wash(`M-20 190C240 160 480 192 760 178C1040 164 1300 150 1560 172C1760 188 1900 170 2020 176V${BH + 20}H-20Z`, { c1: '#adc180', c2: '#a1b878', c3: '#b9ca8c', alpha: 0.85, edge: 0.55, soft: 4, wob: 5 });
    [[160, 176, 120, 26, 'sap'], [520, 190, 90, 20, 'moss'], [1180, 168, 110, 24, 'olive'], [1640, 186, 130, 26, 'sap']].forEach(([x, y, rx, ry, p], i) => P.crown(x, y, rx, ry, PAL[p], { seed: 81 + i, leaf: 0.13 }));
    P.blades(0, 2000, 262, 10, 30, 260, ['#6f8f4a', '#8ba95a', '#b4c872'], { seed: 61 });
    P.finish({ warp: 0.8 });
    push('page-foot', P.canvas, 0.74);
  }

  window.renderAll = async function (which) {
    out.length = 0;
    const t = { meadow, sky, forest, sidebar, backdrop };
    for (const k of which && which.length ? which : Object.keys(t)) {
      t[k]();
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  };
})();
