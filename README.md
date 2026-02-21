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

This version works in pixinsight 1.9.3

------------------------------------------------------------------------

## Requirements

-   PixInsight (recent versions)
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
[Download Adaptive Drizzle Blend (.zip)](https://github.com/danielespitiacolombia/Adaptive-Drizzle-Blend/archive/refs/heads/main.zip)

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

## License

MIT License
You may modify and distribute with attribution.

------------------------------------------------------------------------

## Author

Daniel Espitia
https://www.youtube.com/@AstroVecinos
