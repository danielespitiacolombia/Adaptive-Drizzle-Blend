#feature-id    Utilities > Adaptive Drizzle Blend
#feature-info  Adaptive Drizzle Blend 1.0<br/>by Daniel Espitia
/*
Adaptive Drizzle Blend Beta 1
by Daniel Espitia
*/
/*
Adaptive Drizzle Blend Beta 1
by Daniel Espitia

- Select open views (Drizzle, Normal 1x, Background Preview)
- Auto-detect MONO vs RGB (OSC) based on numberOfChannels (checkbox removed)
- RGB mode: process R/G/B independently + recombine to a single RGB result
- SNR per tile computed on Normal 1x using sigma from Background Preview (MAD)
- 3-way blend: Superpixel (low SNR) + Normal (mid) + Drizzle (high)
- Robust global intensity matching enabled by default
- Superpixel enabled by default (2x2 computed from Normal 1x BEFORE upsampling)
- Output image id: adaptive_blend (only)
- Closes intermediate images at end (keeps inputs + adaptive_blend)
*/

var APP_TITLE  = "Adaptive Drizzle Blend Beta 1";
var APP_AUTHOR = "by Daniel Espitia";

// ---------------- Console progress (single-line) ----------------
var __lastProgLen = 0;
function progressLine(pct, label)
{
   var s = (label ? (label + " ") : "") + pct.toFixed(1) + "%";
   if (__lastProgLen > 0)
      console.write(Array(__lastProgLen + 1).join("\b"));
   console.write(s);
   __lastProgLen = s.length;
   if (typeof console.flush === "function") console.flush();
}
function progressDone()
{
   if (__lastProgLen > 0) console.writeln("");
   __lastProgLen = 0;
}

// ---------------- Utilities ----------------
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

function safeCloseById(id)
{
   var w = ImageWindow.windowById(id);
   if (w && !w.isNull)
   {
      try { w.forceClose(); }
      catch (e) { try { w.close(); } catch (e2) {} }
   }
}

function beginProcessCompat(view)
{
   try { view.beginProcess(); }
   catch (e) { try { view.beginProcess(0); } catch (e2) { throw e2; } }
}
function endProcessCompat(view){ try { view.endProcess(); } catch (e) {} }

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

// --- Channel-safe sample/setSample helpers (PI versions differ) ---
function getSample(img, x, y, c)
{
   // Try 3-arg sample(x,y,c)
   try { return img.sample(x, y, c); } catch (e) {}
   // Fallback: selectedChannel
   try
   {
      var old = img.selectedChannel;
      img.selectedChannel = c;
      var v = img.sample(x, y);
      img.selectedChannel = old;
      return v;
   }
   catch (e2)
   {
      // Last resort
      return img.sample(x, y);
   }
}

function setSampleC(img, v, x, y, c)
{
   // Try 4-arg setSample(v,x,y,c)
   try { img.setSample(v, x, y, c); return; } catch (e) {}
   // Fallback: selectedChannel
   try
   {
      var old = img.selectedChannel;
      img.selectedChannel = c;
      img.setSample(v, x, y);
      img.selectedChannel = old;
      return;
   }
   catch (e2)
   {
      img.setSample(v, x, y);
   }
}

// ---------------- Create images (via NewImage, no includes) ----------------
function createImage(id, W, H, nCh, isColor)
{
   safeCloseById(id);

   var P = new NewImage;
   P.id = id;
   P.width = W;
   P.height = H;
   P.numberOfChannels = nCh;

   // Try to force a 32-bit float image when possible
   try { P.bitsPerSample = 32; } catch(e) {}
   try { P.floatSample = true; } catch(e) {}

   // No alpha
   try { P.alpha = false; } catch(e) {}

   // Color handling differs between PI versions.
   // We try multiple properties to ensure RGB images are created correctly.
   if (isColor)
   {
      // Newer builds
      try { P.color = true; } catch(e1) {}

      // Some builds expose a "colorSpace" property on NewImage
      try
      {
         if (typeof NewImage !== "undefined")
         {
            if (typeof NewImage.prototype.RGB === "number") P.colorSpace = NewImage.prototype.RGB;
            else if (typeof NewImage.prototype.RGBColor === "number") P.colorSpace = NewImage.prototype.RGBColor;
         }
      }
      catch(e2) {}
   }
   else
   {
      try { P.color = false; } catch(e3) {}
      try
      {
         if (typeof NewImage !== "undefined")
         {
            if (typeof NewImage.prototype.Gray === "number") P.colorSpace = NewImage.prototype.Gray;
            else if (typeof NewImage.prototype.Grayscale === "number") P.colorSpace = NewImage.prototype.Grayscale;
         }
      }
      catch(e4) {}
   }

   // Execute
   if (typeof P.executeGlobal === "function")
      P.executeGlobal();
   else if (typeof P.executeOn === "function" && ImageWindow.activeWindow && !ImageWindow.activeWindow.isNull)
      P.executeOn(ImageWindow.activeWindow.mainView);
   else
      throw new Error("NewImage cannot be executed in this PixInsight version.");

   var w = ImageWindow.windowById(id);
   if (!w || w.isNull) throw new Error("Cannot create image: " + id);
   w.show();

   // Sanity check: in some builds, RGB may still come out as mono.
   // We'll report it but continue; combine function has a PixelMath fallback.
   try
   {
      var ch = w.mainView.image.numberOfChannels;
      if (isColor && ch < 3)
         console.writeln("Warning: '" + id + "' created with " + ch + " channel(s) (expected RGB).");
   }
   catch(e5) {}

   return w.mainView;
}

function createMono(id,W,H){ return createImage(id,W,H,1,false); }
function createRGB(id,W,H){ return createImage(id,W,H,3,true); }

// ---------------- Basic operations (mono) ----------------
function extractChannelToMono(srcView, channelIndex, outId, label)
{
   var src = srcView.image;
   var W = src.width, H = src.height;

   var outView = createMono(outId, W, H);
   var dst = outView.image;

   beginProcessCompat(outView);
   try
   {
      for (var y=0; y<H; y++)
      {
         if ((y & 127) === 0) progressLine(100*(y+1)/H, label);
         for (var x=0; x<W; x++)
            dst.setSample(getSample(src, x, y, channelIndex), x, y);
      }
   }
   finally { endProcessCompat(outView); progressDone(); }

   return outView;
}

function upsampleNearestMono(srcView, targetW, targetH, outId, label)
{
   var src = srcView.image;
   var w = src.width, h = src.height;

   var outView = createMono(outId, targetW, targetH);
   var dst = outView.image;

   beginProcessCompat(outView);
   try
   {
      for (var y=0; y<targetH; y++)
      {
         if ((y & 127) === 0) progressLine(100*(y+1)/targetH, label);
         var sy = Math.floor(y * h / targetH);
         for (var x=0; x<targetW; x++)
         {
            var sx = Math.floor(x * w / targetW);
            dst.setSample(src.sample(sx,sy), x, y);
         }
      }
   }
   finally { endProcessCompat(outView); progressDone(); }

   return outView;
}

function superpixel2x2Mono(srcView, outIdSmall, label)
{
   var src = srcView.image;
   var W = src.width, H = src.height;
   var W2 = Math.floor(W/2), H2 = Math.floor(H/2);
   if (W2 < 1 || H2 < 1) throw new Error("Image too small for 2x2 superpixel.");

   var outView = createMono(outIdSmall, W2, H2);
   var dst = outView.image;

   beginProcessCompat(outView);
   try
   {
      for (var y=0; y<H2; y++)
      {
         if ((y & 127) === 0) progressLine(100*(y+1)/H2, label);
         var sy = 2*y;
         for (var x=0; x<W2; x++)
         {
            var sx = 2*x;
            var v = 0.25 * (
               src.sample(sx,sy) + src.sample(sx+1,sy) +
               src.sample(sx,sy+1) + src.sample(sx+1,sy+1)
            );
            dst.setSample(v, x, y);
         }
      }
   }
   finally { endProcessCompat(outView); progressDone(); }

   return outView;
}

// ---------------- Background sigma (MAD) ----------------
function sigmaFromPreviewMAD(bgView, step)
{
   var img = bgView.image;
   var W = img.width, H = img.height;
   if (W < 10 || H < 10) throw new Error("Background preview too small.");

   var a = [];
   for (var y=0; y<H; y+=step)
      for (var x=0; x<W; x+=step)
         a.push(img.sample(x,y));

   return robustMAD(a);
}

// ---------------- Robust global intensity fit (median/MAD) ----------------
function sampleStatsMono(view, step)
{
   var img = view.image;
   var W = img.width, H = img.height;

   var a = [];
   for (var y=0; y<H; y+=step)
      for (var x=0; x<W; x+=step)
         a.push(img.sample(x,y));

   return { med: percentile(a.slice(), 50), mad: robustMAD(a.slice()) };
}

function applyLinearFit(inView, a, b, outId)
{
   safeCloseById(outId);

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
   if (!w || w.isNull) throw new Error("Failed to create: " + outId);
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

// ---------------- SNR per tile (mono) ----------------
function computeTilesSNR(imgView, tile, stride, sigma_bg, label)
{
   var img = imgView.image;
   var W = img.width, H = img.height;

   // Generate tile origins ensuring full coverage, including the last partial tile at right/bottom.
   function axisPositions(L, tile, stride)
   {
      var a = [];
      if (L <= 0) return a;
      if (tile <= 1) tile = 1;
      if (stride < 1) stride = 1;

      var last = Math.max(0, L - tile);

      for (var p = 0; p < L; p += stride)
      {
         if (p > last) break;
         a.push(p);
      }

      // Ensure last position is included
      if (a.length === 0 || a[a.length-1] !== last)
         a.push(last);

      return a;
   }

   var xs = axisPositions(W, tile, stride);
   var ys = axisPositions(H, tile, stride);

   var coords = [];
   var snrList = [];

   var total = xs.length * ys.length;
   var t = 0;

   // Work on channel 0 for mono / extracted mono views
   try { img.selectedChannel = 0; } catch(e) {}

   for (var iy = 0; iy < ys.length; iy++)
   {
      var y0 = ys[iy];
      var th = Math.min(tile, H - y0);

      for (var ix = 0; ix < xs.length; ix++)
      {
         var x0 = xs[ix];
         var tw = Math.min(tile, W - x0);

         var samples = new Array(tw * th);
         var k = 0;

         for (var y = 0; y < th; y++)
            for (var x = 0; x < tw; x++)
               samples[k++] = img.sample(x0 + x, y0 + y);

         var med = percentile(samples.slice(), 50);
         var p95 = percentile(samples.slice(), 95);

         var snr = 0;
         if (sigma_bg > 1e-12)
            snr = (p95 - med) / sigma_bg;
         else
            snr = 0;

         coords.push({ x0:x0, y0:y0, w:tw, h:th });
         snrList.push(snr);

         t++;
         if ((t & 31) === 0 || t === total)
            progressLine(100 * t / total, label);
      }
   }
   progressDone();

   return { coords:coords, snrList:snrList };
}

function logistic01(snr, T, softness)
{
   if (softness <= 0) return (snr >= T) ? 1.0 : 0.0;
   var z = (snr - T) * (4.0/softness);
   return 1.0/(1.0 + Math.exp(-z));
}

function tryFeather(maskView, sigma)
{
   if (sigma <= 0) return;
   try
   {
      var conv = new Convolution;
      conv.mode = Convolution.prototype.Parametric;
      conv.shape = 2; // Gaussian
      conv.sigma = sigma;
      conv.executeOn(maskView);
   }
   catch (e) {}
}

function buildMasks(finalW, finalH, scale, tile1x, coords, snrList, TS, TD, softness, suffix)
{
   var tileF = tile1x * scale;

   var idD = "maskD" + suffix;
   var idN = "maskN" + suffix;
   var idS = "maskS" + suffix;

   var vD = createMono(idD, finalW, finalH);
   var vN = createMono(idN, finalW, finalH);
   var vS = createMono(idS, finalW, finalH);

   var iD = vD.image, iN = vN.image, iS = vS.image;

   beginProcessCompat(vD); beginProcessCompat(vN); beginProcessCompat(vS);
   try
   {
      for (var y=0; y<finalH; y++)
      {
         if ((y & 127) === 0) progressLine(100*(y+1)/finalH, "Init masks");
         for (var x=0; x<finalW; x++)
         {
            iD.setSample(0, x, y);
            iS.setSample(0, x, y);
            iN.setSample(1, x, y);
         }
      }
      progressDone();

      var n = snrList.length;
      for (var t=0; t<n; t++)
      {
         if ((t & 31) === 0 || t === n-1)
            progressLine(100*(t+1)/n, "Fill masks");

         var snr = snrList[t];

         var wD = logistic01(snr, TD, softness);
         var wS = 1.0 - logistic01(snr, TS, softness);
         var wN = 1.0 - wD - wS;

         wD = clamp01(wD); wS = clamp01(wS); wN = clamp01(wN);
         var sum = wD + wS + wN;
         if (sum < 1e-6) { wN = 1.0; sum = 1.0; }
         wD /= sum; wS /= sum; wN /= sum;

         var X0 = coords[t].x0 * scale;
         var Y0 = coords[t].y0 * scale;
         var tw = (coords[t].w ? coords[t].w*scale : tileF);
         var th = (coords[t].h ? coords[t].h*scale : tileF);

         var maxX = Math.min(finalW, X0 + tw);
         var maxY = Math.min(finalH, Y0 + th);

         for (var yy=Y0; yy<maxY; yy++)
            for (var xx=X0; xx<maxX; xx++)
            {
               iD.setSample(wD, xx, yy);
               iS.setSample(wS, xx, yy);
               iN.setSample(wN, xx, yy);
            }
      }
      progressDone();
   }
   finally { endProcessCompat(vD); endProcessCompat(vN); endProcessCompat(vS); }

   return { idD:idD, idN:idN, idS:idS, vD:vD, vN:vN, vS:vS };
}

function buildMasksDN(finalW, finalH, scale, tile1x, coords, snrList, TD, softness, suffix)
{
   var tileF = tile1x * scale;

   var idD = "maskD" + suffix;
   var idN = "maskN" + suffix;

   var vD = createMono(idD, finalW, finalH);
   var vN = createMono(idN, finalW, finalH);

   var iD = vD.image, iN = vN.image;

   beginProcessCompat(vD); beginProcessCompat(vN);
   try
   {
      for (var y=0; y<finalH; y++)
      {
         if ((y & 127) === 0) progressLine(100*(y+1)/finalH, "Init masks");
         for (var x=0; x<finalW; x++)
         {
            iD.setSample(0, x, y);
            iN.setSample(1, x, y);
         }
      }
      progressDone();

      var n = snrList.length;
      for (var t=0; t<n; t++)
      {
         if ((t & 31) === 0 || t === n-1)
            progressLine(100*(t+1)/n, "Fill masks");

         var snr = snrList[t];

         var wD = logistic01(snr, TD, softness);
         var wN = 1.0 - wD;

         wD = clamp01(wD); wN = clamp01(wN);
         var sum = wD + wN;
         if (sum < 1e-6) { wN = 1.0; sum = 1.0; }
         wD /= sum; wN /= sum;

         var X0 = coords[t].x0 * scale;
         var Y0 = coords[t].y0 * scale;
         var tw = (coords[t].w ? coords[t].w*scale : tileF);
         var th = (coords[t].h ? coords[t].h*scale : tileF);

         var maxX = Math.min(finalW, X0 + tw);
         var maxY = Math.min(finalH, Y0 + th);

         for (var yy=Y0; yy<maxY; yy++)
            for (var xx=X0; xx<maxX; xx++)
            {
               iD.setSample(wD, xx, yy);
               iN.setSample(wN, xx, yy);
            }
      }
      progressDone();
   }
   finally { endProcessCompat(vD); endProcessCompat(vN); }

   return { idD:idD, idN:idN, vD:vD, vN:vN };
}

function blend3(drizzleView, normalUpView, superUpView, maskIds, outId)
{
   safeCloseById(outId);

   var PM = new PixelMath;
   PM.expression =
      maskIds.idS + "*" + superUpView.id + " + " +
      maskIds.idN + "*" + normalUpView.id + " + " +
      maskIds.idD + "*" + drizzleView.id;

   PM.useSingleExpression = true;
   PM.generateOutput = true;
   PM.createNewImage = true;
   PM.newImageId = outId;
   PM.newImageSampleFormat = PixelMath.prototype.f32;
   PM.rescale = false;
   PM.executeOn(drizzleView);
}

function blend2(drizzleView, normalUpView, maskIds, outId)
{
   safeCloseById(outId);

   var PM = new PixelMath;
   PM.expression =
      maskIds.idN + "*" + normalUpView.id + " + " +
      maskIds.idD + "*" + drizzleView.id;

   PM.useSingleExpression = true;
   PM.generateOutput = true;
   PM.createNewImage = true;
   PM.newImageId = outId;
   PM.newImageSampleFormat = PixelMath.prototype.f32;
   PM.rescale = false;
   PM.executeOn(drizzleView);
}

function combineRGBManual(rView, gView, bView, outId)
{
   safeCloseById(outId);

   // PixelMath per-channel output (compatible with PI 1.8.9-3: no rgb() function)
   var PM = new PixelMath;
   PM.useSingleExpression = false;

   // Some PI versions use expression0/1/2, others use expressions array.
   try
   {
      PM.expression0 = rView.id;
      PM.expression1 = gView.id;
      PM.expression2 = bView.id;
   }
   catch (e0)
   {
      // Fallback to expressions[] if available
      try
      {
         PM.expressions = [ rView.id, gView.id, bView.id ];
      }
      catch (e1)
      {
         throw new Error("This PixInsight build does not support per-channel PixelMath expressions.");
      }
   }

   PM.generateOutput = true;
   PM.createNewImage = true;
   PM.newImageId = outId;
   PM.newImageSampleFormat = PixelMath.prototype.f32;
   PM.rescale = false;

   // Try to force RGB output if the property exists
   try { PM.newImageColorSpace = PixelMath.prototype.RGB; } catch (e2) {}

   PM.executeOn(rView);

   var w = ImageWindow.windowById(outId);
   if (!w || w.isNull)
      throw new Error("Failed to create: " + outId);

   // Sanity: ensure 3 channels
   try
   {
      if (w.mainView.image.numberOfChannels < 3)
         console.writeln("Warning: '" + outId + "' created with " + w.mainView.image.numberOfChannels + " channel(s).");
   }
   catch (e3) {}

   return w.mainView;
}

// ---------------- Core pipeline (mono) ----------------
function runMono(drizzleMono, normal1xMono, bgMono, superExternalMono, params, suffix)
{
   var statsStep = 8;
   var softness  = 3.0;
   var tile = params.tile;
   var stride = Math.max(1, Math.floor(tile/2));
   var lowP  = params.lowP;
   var highP = params.highP;
   var featherSigma = params.featherSigma;

   if (lowP + highP > 100)
      throw new Error("Low-SNR% + High-SNR% cannot exceed 100.");

   var finalW = drizzleMono.image.width, finalH = drizzleMono.image.height;
   var W1 = normal1xMono.image.width, H1 = normal1xMono.image.height;

   var scaleX = finalW / W1;
   var scaleY = finalH / H1;
   var scale = Math.round(scaleX);

   if (Math.abs(scaleX-scale) > 1e-3 || Math.abs(scaleY-scale) > 1e-3 || scale < 1)
      throw new Error("Drizzle/Normal scale must be integer (1x, 2x, ...).");

   console.writeln("Scale"+suffix+" = " + scale + "x");

   var normalUp = (W1 === finalW && H1 === finalH) ? normal1xMono
                 : upsampleNearestMono(normal1xMono, finalW, finalH, "nodrizzle_up"+suffix, "Upsample normal");

   var useSuper = (lowP > 0);

   // If Low-SNR Areas to Smooth (%) == 0, skip superpixel entirely (even if user selected an external one)
   // to avoid generating unnecessary images and to reduce memory usage.
   var spUp = null;

   if (useSuper)
   {
      // Superpixel: use external image if provided, otherwise generate 2x2 from Normal (1x) before upsampling.
      var spSmall = null;
      if (superExternalMono && !superExternalMono.isNull)
      {
         var ew = superExternalMono.image.width, eh = superExternalMono.image.height;
         var nW = W1, nH = H1;

         if (ew === Math.floor(nW/2) && eh === Math.floor(nH/2))
            spSmall = superExternalMono;
         else if (ew === nW && eh === nH)
            spSmall = superExternalMono;
         else if (ew === finalW && eh === finalH)
            spSmall = superExternalMono;
         else
            throw new Error("External superpixel has invalid dimensions. Expected " +
                            Math.floor(nW/2) + "x" + Math.floor(nH/2) + " (recommended), or " +
                            nW + "x" + nH + ", or " + finalW + "x" + finalH + ".");
      }
      else
      {
         spSmall = superpixel2x2Mono(normal1xMono, "super_small"+suffix, "Superpixel 2x2");
      }

      // Upsample superpixel to final resolution if needed
      if (spSmall.image.width === finalW && spSmall.image.height === finalH)
         spUp = spSmall;
      else
         spUp = upsampleNearestMono(spSmall, finalW, finalH, "super_up"+suffix, "Upsample super");
   }
var sigma_bg = sigmaFromPreviewMAD(bgMono, statsStep);
   console.writeln("sigma_bg"+suffix+" = " + sigma_bg);

   
   var drizzleFit = fitToReference(drizzleMono, normalUp, statsStep, "drz_fit"+suffix);

   var tiles = computeTilesSNR(normal1xMono, tile, stride, sigma_bg, "SNR tiles");

   var TD = percentile(tiles.snrList.slice(), 100 - highP);
   console.writeln("TD"+suffix+" = " + TD);

   var outId = "adaptive_blend" + suffix;

   if (useSuper)
   {
      var TS = percentile(tiles.snrList.slice(), lowP);
      console.writeln("TS"+suffix+" = " + TS);

      var superFit   = fitToReference(spUp, normalUp, statsStep, "sup_fit"+suffix);

      var masks = buildMasks(finalW, finalH, scale, tile, tiles.coords, tiles.snrList, TS, TD, softness, suffix);

      tryFeather(masks.vD, featherSigma);
      tryFeather(masks.vN, featherSigma);
      tryFeather(masks.vS, featherSigma);

      blend3(drizzleFit, normalUp, superFit, masks, outId);
   }
   else
   {
      // 2-way blend (Normal + Drizzle) when lowP == 0: no superpixel path, no extra masks.
      var masks2 = buildMasksDN(finalW, finalH, scale, tile, tiles.coords, tiles.snrList, TD, softness, suffix);

      tryFeather(masks2.vD, featherSigma);
      tryFeather(masks2.vN, featherSigma);

      blend2(drizzleFit, normalUp, masks2, outId);
   }
   var outW = ImageWindow.windowById(outId);
   if (!outW || outW.isNull) throw new Error("Failed to create: " + outId);
   return outW.mainView;
}

// ---------------- Cleanup ----------------
function closeIntermediatesForSuffix(suffix)
{
   var ids = [
      "nodrizzle_up"+suffix,
      "super_small"+suffix,
      "super_up"+suffix,
      "drz_fit"+suffix,
      "sup_fit"+suffix,
      "maskD"+suffix,
      "maskN"+suffix,
      "maskS"+suffix
   ];
   for (var i=0; i<ids.length; i++) safeCloseById(ids[i]);
}

// ---------------- UI ----------------
function hasUI()
{
   return (typeof Dialog !== "undefined") &&
          (typeof ViewList !== "undefined") &&
          (typeof HorizontalSizer !== "undefined") &&
          (typeof VerticalSizer !== "undefined") &&
          (typeof Label !== "undefined") &&
          (typeof Edit !== "undefined") &&
          (typeof PushButton !== "undefined");
}

function Params()
{
   this.tile = 256;
   this.lowP = 10;
   this.highP = 50;
   this.featherSigma = 30.0;

   this.drizzleView = new View;
   this.normalView  = new View;
   this.bgView      = new View;
   this.superView   = new View; // optional external superpixel image (mono or RGB)
}

function AppDialog(params)
{
   this.__base__ = Dialog;
   this.__base__();

   this.windowTitle = APP_TITLE;

   var titleLabel = new Label(this);
   titleLabel.text = APP_TITLE;
   var f = titleLabel.font; f.bold = true; titleLabel.font = f;

   var authorLabel = new Label(this);
   authorLabel.text = APP_AUTHOR;

   var drizzleLabel = new Label(this);
   drizzleLabel.text = "Drizzle View:";

   var drizzleList = new ViewList(this);
   drizzleList.getAll();
   drizzleList.onViewSelected = function(v){ params.drizzleView = v; };

   var normalLabel = new Label(this);
   normalLabel.text = "Normal View (1x):";

   var normalList = new ViewList(this);
   normalList.getAll();
   normalList.onViewSelected = function(v){ params.normalView = v; };

   var bgLabel = new Label(this);
   bgLabel.text = "Background Preview:";

   var bgList = new ViewList(this);
   bgList.getAll();
   bgList.onViewSelected = function(v){ params.bgView = v; };

   var superLabel = new Label(this);
   superLabel.text = "Superpixel View (optional):";

   var superList = new ViewList(this);
   superList.getAll();
   superList.nullViewEnabled = true;
   superList.onViewSelected = function(v){ params.superView = v; };


   var tileLabel = new Label(this);
   tileLabel.text = "Analysis Area Size (px):";

   var tileEdit = new Edit(this);
   tileEdit.text = "" + params.tile;
   tileEdit.onTextUpdated = function(s)
   {
      var n = parseInt(s,10);
      if (!isNaN(n)) params.tile = Math.max(16, Math.min(4096, n));
   };

   var lowLabel = new Label(this);
   lowLabel.text = "Low-SNR Areas to Smooth (%):";

   var lowEdit = new Edit(this);
   lowEdit.text = "" + params.lowP;
   lowEdit.onTextUpdated = function(s)
   {
      var n = parseInt(s,10);
      if (!isNaN(n)) params.lowP = Math.max(0, Math.min(100, n));
   };

   var highLabel = new Label(this);
   highLabel.text = "High-SNR Areas for Drizzle (%):";

   var highEdit = new Edit(this);
   highEdit.text = "" + params.highP;
   highEdit.onTextUpdated = function(s)
   {
      var n = parseInt(s,10);
      if (!isNaN(n)) params.highP = Math.max(0, Math.min(100, n));
   };

   var featherLabel = new Label(this);
   featherLabel.text = "Transition Smoothness:";

   var featherEdit = new Edit(this);
   featherEdit.text = "" + params.featherSigma;
   featherEdit.onTextUpdated = function(s)
   {
      var n = parseFloat(s);
      if (!isNaN(n)) params.featherSigma = Math.max(0, Math.min(200, n));
   };

   var okBtn = new PushButton(this);
   okBtn.text = "Run";
   okBtn.onClick = function(){ this.dialog.ok(); };

   var cancelBtn = new PushButton(this);
   cancelBtn.text = "Cancel";
   cancelBtn.onClick = function(){ this.dialog.cancel(); };

   function row(label, control)
   {
      var h = new HorizontalSizer;
      h.spacing = 6;
      h.add(label);
      h.add(control, 100);
      return h;
   }

   var top = new VerticalSizer;
   top.margin = 10;
   top.spacing = 8;

   top.add(titleLabel);
   top.add(authorLabel);

   top.add(row(drizzleLabel, drizzleList));
   top.add(row(normalLabel, normalList));
   top.add(row(bgLabel, bgList));
   top.add(row(superLabel, superList));


   top.add(row(tileLabel, tileEdit));
   top.add(row(lowLabel, lowEdit));
   top.add(row(highLabel, highEdit));
   top.add(row(featherLabel, featherEdit));

   var btnRow = new HorizontalSizer;
   btnRow.addStretch();
   btnRow.add(okBtn);
   btnRow.add(cancelBtn);

   top.add(btnRow);

   this.sizer = top;
   this.adjustToContents();
}
AppDialog.prototype = new Dialog;

// ---------------- Main ----------------
function main()
{
   console.show();
   console.writeln("=== " + APP_TITLE + " ===");
   console.writeln(APP_AUTHOR);

   if (!hasUI())
   {
      console.writeln("*** Error: UI classes not available in this PixInsight environment.");
      return;
   }

   var params = new Params();
   var dlg = new AppDialog(params);
   if (!dlg.execute()) return;

   if (params.drizzleView.isNull || params.normalView.isNull)
      throw new Error("Please select Drizzle and Normal views.");
   if (params.bgView.isNull)
      throw new Error("Please select a Background Preview.");
   if (params.drizzleView.id === params.normalView.id)
      throw new Error("Drizzle and Normal must be different views.");

   var drzCh = params.drizzleView.image.numberOfChannels;
   var norCh = params.normalView.image.numberOfChannels;
   var bgCh  = params.bgView.image.numberOfChannels;

   var isRGB  = (drzCh >= 3 && norCh >= 3);
   var isMono = (drzCh === 1 && norCh === 1);

   if (!isRGB && !isMono)
      throw new Error("Unsupported channel configuration. Use either MONO (1 channel) or RGB (3 channels) images.");
   if (drzCh !== norCh)
      throw new Error("Drizzle and Normal must have the same number of channels.");

   if (isMono && bgCh !== 1)
      throw new Error("Mono mode: Background preview must be mono (create it on a mono image).");
   if (isRGB && bgCh < 3)
      throw new Error("RGB mode: Background preview must be RGB (create it on an RGB image).");

   console.writeln("Auto mode: " + (isRGB ? "RGB (OSC)" : "Mono"));

   // Optional external superpixel validation
   if (!params.superView.isNull)
   {
      var supCh = params.superView.image.numberOfChannels;
      if (isMono && supCh !== 1)
         throw new Error("Mono mode: External superpixel view must be mono (1 channel).");
      if (isRGB && supCh < 3)
         throw new Error("RGB mode: External superpixel view must be RGB (3 channels).");
   }


   safeCloseById("adaptive_blend");

   try
   {
      if (isMono)
      {
         var out = runMono(params.drizzleView, params.normalView, params.bgView, params.superView, params, "");
         console.writeln("Done: " + out.id);
         closeIntermediatesForSuffix("");
      }
      else
      {
         console.writeln("Extract channels...");
         var drzR = extractChannelToMono(params.drizzleView, 0, "drz_R", "Extract Drizzle R");
         var drzG = extractChannelToMono(params.drizzleView, 1, "drz_G", "Extract Drizzle G");
         var drzB = extractChannelToMono(params.drizzleView, 2, "drz_B", "Extract Drizzle B");

         var norR = extractChannelToMono(params.normalView, 0, "nor_R", "Extract Normal R");
         var norG = extractChannelToMono(params.normalView, 1, "nor_G", "Extract Normal G");
         var norB = extractChannelToMono(params.normalView, 2, "nor_B", "Extract Normal B");

         var bgR  = extractChannelToMono(params.bgView, 0, "bg_R", "Extract BG R");
         var bgG  = extractChannelToMono(params.bgView, 1, "bg_G", "Extract BG G");
         var bgB  = extractChannelToMono(params.bgView, 2, "bg_B", "Extract BG B");

         // Optional external superpixel (RGB): if provided, extract channels; otherwise script will generate superpixel.
         var supR = new View, supG = new View, supB = new View;
         if (!params.superView.isNull)
         {
            if (params.superView.image.numberOfChannels < 3)
               throw new Error("RGB mode: External superpixel view must be RGB (3 channels) if provided.");
            supR = extractChannelToMono(params.superView, 0, "sup_R", "Extract Super R");
            supG = extractChannelToMono(params.superView, 1, "sup_G", "Extract Super G");
            supB = extractChannelToMono(params.superView, 2, "sup_B", "Extract Super B");
         }


         console.writeln("Process R...");
         var outR = runMono(drzR, norR, bgR, supR, params, "_R");
         closeIntermediatesForSuffix("_R");

         console.writeln("Process G...");
         var outG = runMono(drzG, norG, bgG, supG, params, "_G");
         closeIntermediatesForSuffix("_G");

         console.writeln("Process B...");
         var outB = runMono(drzB, norB, bgB, supB, params, "_B");
         closeIntermediatesForSuffix("_B");

         console.writeln("Combine RGB -> adaptive_blend ...");
         combineRGBManual(outR, outG, outB, "adaptive_blend");
         console.writeln("Done: adaptive_blend");
         // Close extracted external superpixel channels (if any)
         safeCloseById("sup_R"); safeCloseById("sup_G"); safeCloseById("sup_B");

         // Close extracted channels and channel outputs (keep only inputs + adaptive_blend)
         safeCloseById("drz_R"); safeCloseById("drz_G"); safeCloseById("drz_B");
         safeCloseById("nor_R"); safeCloseById("nor_G"); safeCloseById("nor_B");
         safeCloseById("bg_R");  safeCloseById("bg_G");  safeCloseById("bg_B");

         safeCloseById("adaptive_blend_R");
         safeCloseById("adaptive_blend_G");
         safeCloseById("adaptive_blend_B");

         // NOTE: Keeping channel intermediates open for verification (requested).
         // The following windows remain: drz_R/G/B, nor_R/G/B, bg_R/G/B, adaptive_blend_R/G/B.
      }
   }
   catch (e)
   {
      progressDone();
      console.writeln("\n*** Error: " + e);
   }
}

main();
