/*
Adaptive Drizzle Blend Beta 1
by Daniel Espitia

MONO LINEAR adaptive blend using:
- DRIZZLE (high-res) + NORMAL (1x) + SUPERPIXEL (2x2 from 1x, then upscaled)
- SNR per tile computed from NORMAL(1x) using sigma_bg from a BACKGROUND PREVIEW (MAD)
- Always applies global intensity matching (robust fit: median+MAD) to DRIZZLE and SUPERPIXEL, matching NORMAL_UP
- Always uses SUPERPIXEL (3-way)
- UI simplified: only 4 controls + image/preview selectors

UI fields:
- Analysis Area Size (px)            [tile @1x]
- Low-SNR Areas to Smooth (%)        [bottom percentile -> superpixel] (default 10)
- High-SNR Areas for Drizzle (%)     [top percentile -> drizzle] (default 50)
- Transition Smoothness              [feather sigma @final]

Hidden:
- Stride = tile/2
- Softness = 3.0
- Stats step = 8

Also:
- Intermediates are closed at the end (keeps inputs and final result)

NEW:
- Console progress shown on ONE line using backspaces (no spam)
- Throttled progress updates (less frequent)
*/

var __lastProgLen = 0;

function showProgress(current, total, prefix)
{
   if (total <= 0) total = 1;
   var p = Math.floor(100 * current / total);
   if (p < 0) p = 0; if (p > 100) p = 100;

   var msg = prefix + " " + p + "%";

   if (__lastProgLen > 0)
      console.write( Array(__lastProgLen + 1).join("\b") );

   console.write(msg);
   __lastProgLen = msg.length;

   if (typeof console.flush === "function") console.flush();

   if (current >= total)
   {
      console.writeln("");
      __lastProgLen = 0;
   }
}

function checkAbort()
{
   if (console.abortRequested)
      throw new Error("Aborted by user.");
}

function robustMAD(a)
{
   a.sort(function(x,y){return x-y;});
   var n = a.length;
   if (n < 10) return 1e-6;
   var med = a[(n/2)|0];

   var d = new Array(n);
   for (var i=0;i<n;i++) d[i] = Math.abs(a[i]-med);
   d.sort(function(x,y){return x-y;});
   var mad = d[(n/2)|0];

   return 1.4826*mad + 1e-6;
}

function percentile(a,p)
{
   a.sort(function(x,y){return x-y;});
   var n = a.length;
   if (n === 0) return 0;
   var idx = Math.round((p/100)*(n-1));
   idx = Math.max(0, Math.min(n-1, idx));
   return a[idx];
}

function clamp01(x){ return x<0?0:(x>1?1:x); }

function safeCloseWindowById(id)
{
   var w = ImageWindow.windowById(id);
   if (w && !w.isNull)
   {
      try { w.forceClose(); }
      catch (e) { try { w.close(); } catch (e2) {} }
   }
}

function closeIntermediateWindows()
{
   var ids = [
      "nodrizzle_up",
      "superpixel_small",
      "superpixel_up",
      "drizzle_fit",
      "super_fit",
      "mask_D",
      "mask_N",
      "mask_S"
   ];
   for (var i=0; i<ids.length; i++)
      safeCloseWindowById(ids[i]);
}

function beginProcessCompat(view)
{
   try { view.beginProcess(); }
   catch (e)
   {
      try { view.beginProcess(0); }
      catch (e2) { throw e2; }
   }
}

function endProcessCompat(view){ try { view.endProcess(); } catch (e) {} }

function createMonoImage(id, W, H)
{
   safeCloseWindowById(id);

   var P = new NewImage;
   P.id = id;
   P.width = W;
   P.height = H;
   P.numberOfChannels = 1;

   try { P.bitsPerSample = 32; } catch(e) {}
   try { P.floatSample = true; } catch(e) {}
   try { P.alpha = false; } catch(e) {}
   try { P.color = false; } catch(e) {}

   if (typeof P.executeGlobal === "function")
      P.executeGlobal();
   else if (typeof P.executeOn === "function" && ImageWindow.activeWindow && !ImageWindow.activeWindow.isNull)
      P.executeOn(ImageWindow.activeWindow.mainView);
   else
      throw new Error("Cannot run NewImage in this PixInsight version.");

   var win = ImageWindow.windowById(id);
   if (!win || win.isNull)
      throw new Error("Cannot find created window: " + id);

   win.show();
   return win;
}

// Nearest upsample (mono) + progress
function upsampleNearestMono(srcView, W, H, outId, progressPrefix)
{
   var src = srcView.image;
   var w = src.width, h = src.height;

   var win = createMonoImage(outId, W, H);
   var dstView = win.mainView;
   var dst = dstView.image;

   src.selectedChannel = 0;
   dst.selectedChannel = 0;

   beginProcessCompat(dstView);
   try
   {
      for (var y=0; y<H; y++)
      {
         if ((y & 63) === 0) { showProgress(y+1, H, progressPrefix); checkAbort(); }
         var sy = Math.floor(y * h / H);
         for (var x=0; x<W; x++)
         {
            var sx = Math.floor(x * w / W);
            dst.setSample(src.sample(sx, sy), x, y);
         }
      }
      showProgress(H, H, progressPrefix);
   }
   finally { endProcessCompat(dstView); }

   return dstView;
}

// Superpixel 2x2 average (mono) + progress
function makeSuperpixel2x2Mono(srcView, outIdSmall)
{
   var src = srcView.image;
   var W = src.width, H = src.height;

   var W2 = Math.floor(W/2);
   var H2 = Math.floor(H/2);
   if (W2 < 1 || H2 < 1)
      throw new Error("Image too small for 2x2 superpixel.");

   var win = createMonoImage(outIdSmall, W2, H2);
   var dstView = win.mainView;
   var dst = dstView.image;

   src.selectedChannel = 0;
   dst.selectedChannel = 0;

   beginProcessCompat(dstView);
   try
   {
      for (var y=0; y<H2; y++)
      {
         if ((y & 63) === 0) { showProgress(y+1, H2, "Superpixel:"); checkAbort(); }
         var sy = 2*y;
         for (var x=0; x<W2; x++)
         {
            var sx = 2*x;

            var s00 = src.sample(sx,   sy);
            var s10 = src.sample(sx+1, sy);
            var s01 = src.sample(sx,   sy+1);
            var s11 = src.sample(sx+1, sy+1);

            dst.setSample(0.25*(s00+s10+s01+s11), x, y);
         }
      }
      showProgress(H2, H2, "Superpixel:");
   }
   finally { endProcessCompat(dstView); }

   return dstView;
}

// sigma_bg from background preview (MAD)
function sigmaFromPreviewMAD(previewView, step)
{
   var img = previewView.image;
   img.selectedChannel = 0;
   var W = img.width, H = img.height;
   if (W < 10 || H < 10)
      throw new Error("Background preview too small.");

   var samples = [];
   for (var y=0; y<H; y+=step)
      for (var x=0; x<W; x+=step)
         samples.push(img.sample(x,y));

   return robustMAD(samples);
}

// global stats (median+MAD) for robust fit
function sampleStatsMono(view, step)
{
   var img = view.image;
   img.selectedChannel = 0;
   var W = img.width, H = img.height;

   var samples = [];
   for (var y=0; y<H; y+=step)
      for (var x=0; x<W; x+=step)
         samples.push(img.sample(x,y));

   var med = percentile(samples.slice(), 50);
   var mad = robustMAD(samples.slice());
   return {med: med, mad: mad};
}

// SNR per tile in 1x using fixed sigma_bg + progress
function computeTileSNR(baseView, W, H, tile, stride, sigma_bg)
{
   var img = baseView.image;
   img.selectedChannel = 0;

   var snrList = [];
   var coords = [];

   var totalTiles = 0;
   for (var y0=0; y0<=H-tile; y0+=stride)
      for (var x0=0; x0<=W-tile; x0+=stride)
         totalTiles++;

   var tileIndex = 0;

   for (var y0=0; y0<=H-tile; y0+=stride)
      for (var x0=0; x0<=W-tile; x0+=stride)
      {
         tileIndex++;
         if ((tileIndex & 31) === 0 || tileIndex === totalTiles)
         {
            showProgress(tileIndex, totalTiles, "Computing SNR:");
            checkAbort();
         }

         var samples = new Array(tile*tile);
         var k = 0;
         for (var y=0; y<tile; y++)
            for (var x=0; x<tile; x++)
               samples[k++] = img.sample(x0+x, y0+y);

         var med = percentile(samples.slice(), 50);
         var p95 = percentile(samples.slice(), 95);

         var snr = (p95 - med)/sigma_bg;

         snrList.push(snr);
         coords.push({x0:x0, y0:y0});
      }

   showProgress(totalTiles, totalTiles, "Computing SNR:");
   return {snrList: snrList, coords: coords};
}

function logistic01(snr, T, softness)
{
   if (softness <= 0) return (snr >= T) ? 1.0 : 0.0;
   var z = (snr - T) * (4.0/softness);
   return 1.0/(1.0 + Math.exp(-z));
}

// Init masks to avoid black borders
function initMasks3(iD, iS, iN, W, H)
{
   for (var y=0; y<H; y++)
      for (var x=0; x<W; x++)
      {
         iD.setSample(0.0, x, y);
         iS.setSample(0.0, x, y);
         iN.setSample(1.0, x, y);
      }
}

// Build 3 masks at final resolution (projecting tiles from 1x) + progress
function buildMasks3Scaled(finalW, finalH, scale, tile1x, coords1x, snrList, TS, TD, softness)
{
   var tileF = tile1x * scale;

   var wDwin = createMonoImage("mask_D", finalW, finalH);
   var wSwin = createMonoImage("mask_S", finalW, finalH);
   var wNwin = createMonoImage("mask_N", finalW, finalH);

   var vD = wDwin.mainView, vS = wSwin.mainView, vN = wNwin.mainView;
   var iD = vD.image, iS = vS.image, iN = vN.image;
   iD.selectedChannel = 0; iS.selectedChannel = 0; iN.selectedChannel = 0;

   beginProcessCompat(vD); beginProcessCompat(vS); beginProcessCompat(vN);
   try
   {
      initMasks3(iD, iS, iN, finalW, finalH);

      for (var i=0; i<snrList.length; i++)
      {
         if ((i & 31) === 0 || i === snrList.length-1)
         {
            showProgress(i+1, snrList.length, "Building masks:");
            checkAbort();
         }

         var snr = snrList[i];

         var wD = logistic01(snr, TD, softness);
         var wS = 1.0 - logistic01(snr, TS, softness);
         var wN = 1.0 - wD - wS;

         wD = clamp01(wD); wS = clamp01(wS); wN = clamp01(wN);
         var sum = wD + wS + wN;
         if (sum < 1e-6) { wN = 1.0; sum = 1.0; }
         wD /= sum; wS /= sum; wN /= sum;

         var X0 = coords1x[i].x0 * scale;
         var Y0 = coords1x[i].y0 * scale;

         var maxX = Math.min(finalW, X0 + tileF);
         var maxY = Math.min(finalH, Y0 + tileF);

         for (var y=Y0; y<maxY; y++)
            for (var x=X0; x<maxX; x++)
            {
               iD.setSample(wD, x, y);
               iS.setSample(wS, x, y);
               iN.setSample(wN, x, y);
            }
      }
      showProgress(snrList.length, snrList.length, "Building masks:");
   }
   finally
   {
      endProcessCompat(vD); endProcessCompat(vS); endProcessCompat(vN);
   }

   return {vD:vD, vS:vS, vN:vN};
}

function feather(view, sigma)
{
   if (sigma <= 0) return;
   try
   {
      var conv = new Convolution;
      conv.mode = Convolution.prototype.Parametric;
      conv.shape = 2;
      conv.sigma = sigma;
      conv.executeOn(view);
   }
   catch(e) {}
}

// Robust global intensity fit via PixelMath: out = a*in + b
function applyLinearFit(inView, a, b, outId)
{
   safeCloseWindowById(outId);

   var PM = new PixelMath;
   PM.expression = "(" + a + ")*" + inView.id + " + (" + b + ")";
   PM.useSingleExpression = true;
   PM.generateOutput = true;
   PM.createNewImage = true;
   PM.newImageId = outId;
   PM.newImageSampleFormat = PixelMath.prototype.f32;
   PM.rescale = false;
   PM.executeOn(inView);

   var w = ImageWindow.windowById(outId);
   if (!w || w.isNull) throw new Error("Failed to create " + outId);
   return w.mainView;
}

function fitToReference(inView, refView, step, outId)
{
   var ref = sampleStatsMono(refView, step);
   var src = sampleStatsMono(inView, step);

   var a = ref.mad / src.mad;
   var b = ref.med - a*src.med;

   console.writeln("Fit " + inView.id + " -> " + refView.id + "   a=" + a + "   b=" + b);
   return applyLinearFit(inView, a, b, outId);
}

function blend3(drizzleView, normalUpView, superUpView, outId)
{
   safeCloseWindowById(outId);
   var PM = new PixelMath;
   PM.expression = "mask_S*" + superUpView.id + " + mask_N*" + normalUpView.id + " + mask_D*" + drizzleView.id;
   PM.useSingleExpression = true;
   PM.generateOutput = true;
   PM.createNewImage = true;
   PM.newImageId = outId;
   PM.newImageSampleFormat = PixelMath.prototype.f32;
   PM.rescale = false;
   PM.executeOn(drizzleView);
}

// ---------------- UI (simplified) ----------------
function AdaptiveData()
{
   var w = ImageWindow.activeWindow;
   if (!w.isNull){ this.drizzleView = w.currentView; this.normalView = w.currentView; }
   else { this.drizzleView = new View; this.normalView = new View; }

   this.bgPreview = new View;

   // UI params (defaults)
   this.tile = 256;
   this.lowSmooth = 10;   // DEFAULT CHANGED TO 10%
   this.highDrizzle = 50;
   this.transition = 30.0;

   // Internal fixed params
   this.statsStep = 8;
   this.softness = 3.0;
}
var data = new AdaptiveData();

function clampInt(x, lo, hi, fb){ var n=parseInt(x,10); if(isNaN(n))return fb; return n<lo?lo:(n>hi?hi:n); }
function clampFloat(x, lo, hi, fb){ var n=parseFloat(x); if(isNaN(n))return fb; return n<lo?lo:(n>hi?hi:n); }

function AppDialog()
{
   this.__base__ = Dialog; this.__base__();

   this.titleLabel = new Label(this);
   this.titleLabel.text = "Adaptive Drizzle Blend Beta 1";
   var f = this.titleLabel.font; f.bold = true; this.titleLabel.font = f;

   this.authorLabel = new Label(this);
   this.authorLabel.text = "by Daniel Espitia";

   // Views
   this.drizzleLabel = new Label(this); this.drizzleLabel.text = "Drizzle View:";
   this.drizzleList = new ViewList(this); this.drizzleList.getAll();
   this.drizzleList.currentView = data.drizzleView;
   this.drizzleList.onViewSelected = function(v){ data.drizzleView = v; };
   this.drizzleSizer = new HorizontalSizer; this.drizzleSizer.add(this.drizzleLabel); this.drizzleSizer.add(this.drizzleList);

   this.normalLabel = new Label(this); this.normalLabel.text = "Normal View (1x):";
   this.normalList = new ViewList(this); this.normalList.getAll();
   this.normalList.currentView = data.normalView;
   this.normalList.onViewSelected = function(v){ data.normalView = v; };
   this.normalSizer = new HorizontalSizer; this.normalSizer.add(this.normalLabel); this.normalSizer.add(this.normalList);

   this.bgLabel = new Label(this); this.bgLabel.text = "Background Preview:";
   this.bgList = new ViewList(this); this.bgList.getAll();
   this.bgList.currentView = data.bgPreview;
   this.bgList.onViewSelected = function(v){ data.bgPreview = v; };
   this.bgSizer = new HorizontalSizer; this.bgSizer.add(this.bgLabel); this.bgSizer.add(this.bgList);

   // Params
   this.tileLabel = new Label(this); this.tileLabel.text = "Analysis Area Size (px):";
   this.tileEdit = new Edit(this); this.tileEdit.text = ""+data.tile;
   this.tileEdit.onTextUpdated = function(s){ data.tile = clampInt(s,16,4096,data.tile); };
   this.tileSizer = new HorizontalSizer; this.tileSizer.add(this.tileLabel); this.tileSizer.add(this.tileEdit);

   this.lowLabel = new Label(this); this.lowLabel.text = "Low-SNR Areas to Smooth (%):";
   this.lowEdit = new Edit(this); this.lowEdit.text = ""+data.lowSmooth;
   this.lowEdit.onTextUpdated = function(s){ data.lowSmooth = clampInt(s,0,100,data.lowSmooth); };
   this.lowSizer = new HorizontalSizer; this.lowSizer.add(this.lowLabel); this.lowSizer.add(this.lowEdit);

   this.highLabel = new Label(this); this.highLabel.text = "High-SNR Areas for Drizzle (%):";
   this.highEdit = new Edit(this); this.highEdit.text = ""+data.highDrizzle;
   this.highEdit.onTextUpdated = function(s){ data.highDrizzle = clampInt(s,0,100,data.highDrizzle); };
   this.highSizer = new HorizontalSizer; this.highSizer.add(this.highLabel); this.highSizer.add(this.highEdit);

   this.trLabel = new Label(this); this.trLabel.text = "Transition Smoothness:";
   this.trEdit = new Edit(this); this.trEdit.text = ""+data.transition;
   this.trEdit.onTextUpdated = function(s){ data.transition = clampFloat(s,0,200,data.transition); };
   this.trSizer = new HorizontalSizer; this.trSizer.add(this.trLabel); this.trSizer.add(this.trEdit);

   // Buttons
   this.okBtn = new PushButton(this); this.okBtn.text = "Run";
   this.okBtn.onClick = function(){ this.dialog.ok(); };
   this.cancelBtn = new PushButton(this); this.cancelBtn.text = "Cancel";
   this.cancelBtn.onClick = function(){ this.dialog.cancel(); };
   this.btnSizer = new HorizontalSizer; this.btnSizer.addStretch(); this.btnSizer.add(this.okBtn); this.btnSizer.add(this.cancelBtn);

   // Layout
   this.sizer = new VerticalSizer;
   this.sizer.margin = 10; this.sizer.spacing = 8;

   this.sizer.add(this.titleLabel);
   this.sizer.add(this.authorLabel);

   this.sizer.add(this.drizzleSizer);
   this.sizer.add(this.normalSizer);
   this.sizer.add(this.bgSizer);

   this.sizer.add(this.tileSizer);
   this.sizer.add(this.lowSizer);
   this.sizer.add(this.highSizer);
   this.sizer.add(this.trSizer);

   this.sizer.add(this.btnSizer);

   this.windowTitle = "Adaptive Drizzle Blend Beta 1";
   this.adjustToContents();
}
AppDialog.prototype = new Dialog;

// ---------------- main ----------------
function main()
{
   console.show();
   if (ImageWindow.windows.length < 2){ console.writeln("Open at least 2 images."); return; }

   var dlg = new AppDialog();
   if (!dlg.execute()) return;

   var drz = data.drizzleView;
   var norOrig = data.normalView; // 1x original
   var bg = data.bgPreview;

   if (drz.isNull || norOrig.isNull){ console.writeln("Select Drizzle and Normal views."); return; }
   if (drz.id == norOrig.id){ console.writeln("Select two different views."); return; }
   if (bg.isNull){ console.writeln("Select a Background Preview."); return; }

   if (drz.image.numberOfChannels != 1 || norOrig.image.numberOfChannels != 1)
   {
      console.writeln("ERROR: MONO only.");
      return;
   }

   try
   {
      console.writeln("=== Adaptive Drizzle Blend Beta 1 ===");

      var finalW = drz.image.width, finalH = drz.image.height;
      var origW = norOrig.image.width, origH = norOrig.image.height;

      var scaleX = finalW / origW;
      var scaleY = finalH / origH;
      var scale = Math.round(scaleX);

      console.writeln("DRIZZLE: " + drz.id + "  " + finalW + "x" + finalH);
      console.writeln("NORMAL(1x): " + norOrig.id + "  " + origW + "x" + origH);

      if (Math.abs(scaleX - scale) > 1e-3 || Math.abs(scaleY - scale) > 1e-3 || scale < 1)
         throw new Error("drizzle/normal scale must be integer (1x or 2x).");

      // NORMAL_UP to final (generated only if needed)
      var norUp = (origW == finalW && origH == finalH) ? norOrig
                 : upsampleNearestMono(norOrig, finalW, finalH, "nodrizzle_up", "Upsampling normal:");

      // SUPERPIXEL always ON: norOrig (1x) -> small (0.5x) -> up to final
      console.writeln("Superpixel 2x2 from NORMAL(1x)...");
      var spSmall = makeSuperpixel2x2Mono(norOrig, "superpixel_small");

      console.writeln("Upscaling superpixel to final...");
      var spUp = upsampleNearestMono(spSmall, finalW, finalH, "superpixel_up", "Upsampling super:");

      // sigma_bg from preview
      var sigma_bg = sigmaFromPreviewMAD(bg, data.statsStep);
      console.writeln("sigma_bg (preview MAD) = " + sigma_bg);

      // FIT always ON
      console.writeln("Robust intensity matching (fit)...");
      var drzFit = fitToReference(drz, norUp, data.statsStep, "drizzle_fit");
      var spFit  = fitToReference(spUp, norUp, data.statsStep, "super_fit");

      // Tile params
      var tile = data.tile;
      var stride = Math.max(1, Math.floor(tile/2)); // hidden: 50% overlap
      var softness = data.softness;

      var lowP = data.lowSmooth;
      var highP = data.highDrizzle;
      if (lowP + highP > 100)
         throw new Error("Low-SNR% + High-SNR% cannot exceed 100.");

      console.writeln("Tile=" + tile + "  stride=" + stride + "  low%=" + lowP + "  high%=" + highP);

      // SNR tiles
      var r = computeTileSNR(norOrig, origW, origH, tile, stride, sigma_bg);
      if (r.snrList.length < 1)
         throw new Error("No tiles. Reduce Analysis Area Size.");

      var TD = percentile(r.snrList.slice(), 100 - highP);
      var TS = percentile(r.snrList.slice(), lowP);
      console.writeln("SNR thresholds: TS(low)=" + TS + "  TD(high)=" + TD);

      // Masks
      var m = buildMasks3Scaled(finalW, finalH, scale, tile, r.coords, r.snrList, TS, TD, softness);

      // Feather
      console.writeln("Feather masks (Transition Smoothness)...");
      feather(m.vD, data.transition);
      feather(m.vN, data.transition);
      feather(m.vS, data.transition);

      // Blend
      console.writeln("Blending...");
      blend3(drzFit, norUp, spFit, "adaptive_blend_3");
      console.writeln("Done: adaptive_blend_3");
   }
   catch (e)
   {
      console.writeln("\n*** Error: " + e);
   }
   finally
   {
      closeIntermediateWindows();
      console.writeln("Intermediates closed.");
   }
}

main();