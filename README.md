# Adaptive Drizzle Blend for PixInsight

**by Daniel Espitia**

Adaptive Drizzle Blend is an advanced PixInsight script designed to
intelligently combine multiple resolution versions of the same image
based on local Signal-to-Noise Ratio (SNR).

Instead of applying Drizzle globally, this tool analyzes the image in
local regions and dynamically blends:

-   High-SNR areas → Drizzle (maximum resolution)
-   Medium-SNR areas → Normal integration
-   Low-SNR areas → Superpixel smoothing (higher effective SNR)

This produces improved detail where data supports it, while reducing
noise where the signal is weak --- all with smooth, physically
consistent transitions.

------------------------------------------------------------------------

## Requirements

-   PixInsight 1.9.3
-   Linear starless images only
-   Drizzle and Normal integrations must be aligned
-   A background preview in the normal integration image (for noise estimation)
    
------------------------------------------------------------------------

## User Controls

-   **Analysis Area Size (px)** -- Size of local region used for SNR
    analysis
-   **Low-SNR Areas to Smooth (%)** -- Percentage of lowest-SNR regions
    assigned to superpixel smoothing
-   **High-SNR Areas for Drizzle (%)** -- Percentage of highest-SNR
    regions assigned to drizzle dominance
-   **Transition Smoothness** -- Feather strength for blending masks

------------------------------------------------------------------------

## Download

👉 **Direct Download:**\
[Download Adaptive Drizzle Blend 1.0 (.zip)](https://github.com/danielespitiacolombia/Adaptive-Drizzle-Blend/archive/refs/heads/main.zip)

------------------------------------------------------------------------

## Installation

1.  Download and extract the zip file Adaptive-Drizzle-Blend-main.zip
2.  In PixInsight go to: Script → Feature Scripts → Add
3.  Select the downloaded file folder
4.  The script will appear under: Script → Utilities

------------------------------------------------------------------------

## Recommended Workflow

1.  Perform Normal Integration (1x)
2.  Perform Drizzle Integration (2x)
3.  Color calibration
4.  Gradient correction
5.  Remove stars from both images
6.  Create a small background preview (in the Normal Integration image)
4.  Run Adaptive Drizzle Blend
5.  Continue processing as usual

------------------------------------------------------------------------
## 📘 Usage Examples

### 1️⃣ Using an External Superpixel Image  
*(Recommended for advanced workflows)*

**When to use:**  
You have already generated a high-quality 2×2 superpixel image manually (e.g., using superpixel debayer or bin 2 capture) and want full control over smoothing behavior.

#### Steps:
1. Select:
   - **Drizzle image** (2× resolution integration)
   - **Normal image** (1× integration)
   - **Background Preview**
2. In **Superpixel View (optional)**, select your external superpixel image.
3. Set:
   - **Low-SNR Areas to Smooth (%)** > 0 (e.g., 10–20%)
   - **High-SNR Areas for Drizzle (%)** (e.g., 50%)
4. Run the script.

#### What happens:
- Low-SNR areas use your external superpixel.
- Mid-SNR areas use the normal image.
- High-SNR areas use drizzle.

**Recommended when:**
- You want to pre-control noise reduction.
- You experimented with different binning or denoise strategies.
- You want maximum reproducibility.

---

### 2️⃣ Using Script-Generated Superpixel  
*(Default workflow)*

**When to use:**  
You do not have a pre-generated superpixel image.

#### Steps:
1. Select:
   - **Drizzle image**
   - **Normal image**
   - **Background Preview**
2. Leave **Superpixel View** empty.
3. Set:
   - **Low-SNR Areas to Smooth (%)** (e.g., 10%)
   - **High-SNR Areas for Drizzle (%)** (e.g., 50%)
4. Run the script.

#### What happens:
- The script generates a 2×2 superpixel from the Normal image.
- It upsamples it to drizzle scale.
- It blends Superpixel / Normal / Drizzle based on local SNR.

**Recommended when:**
- You want an automatic adaptive blend.
- You do not want to create superpixel images manually.
- You want a balanced noise vs resolution tradeoff.

---

### 3️⃣ Without Superpixel (Two-Way Blend Only)

**When to use:**  
You want a clean adaptive blend only between Normal and Drizzle, without additional smoothing.

#### Steps:
1. Select:
   - **Drizzle image**
   - **Normal image**
   - **Background Preview**
2. Leave **Superpixel View** empty.
3. Set:
   - **Low-SNR Areas to Smooth (%) = 0**
4. Run the script.

#### What happens:
- The superpixel path is completely disabled.
- No superpixel images are generated.
- The script blends only:
  - Normal in low-SNR areas
  - Drizzle in high-SNR areas.

**Recommended when:**
- Your integration already has good SNR.
- You only want resolution recovery without additional smoothing.
- You want minimal memory usage.

---

## License

MIT License
You may modify and distribute with attribution.

------------------------------------------------------------------------

## Author

Daniel Espitia
https://www.youtube.com/@AstroVecinos
