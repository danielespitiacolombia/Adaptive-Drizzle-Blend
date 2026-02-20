# Adaptive Drizzle Blend for PixInsight  
**by Daniel Espitia**

Adaptive Drizzle Blend is an advanced PixInsight script designed to intelligently combine multiple resolution versions of the same image based on local Signal-to-Noise Ratio (SNR).

Instead of applying Drizzle globally, this tool analyzes the image in local regions and dynamically blends:

- High-SNR areas → Drizzle (maximum resolution)  
- Medium-SNR areas → Normal integration  
- Low-SNR areas → Superpixel smoothing (higher effective SNR)  

This produces improved detail where data supports it, while reducing noise where the signal is weak — all with smooth, physically consistent transitions.

---

## How It Works

1. Computes local SNR per tile using a background preview (MAD-based noise estimation)
2. Determines percentile-based thresholds for:
   - Low-SNR smoothing
   - High-SNR drizzle dominance
3. Automatically generates a 2x2 superpixel version from the normal integration
4. Applies robust global intensity matching
5. Performs adaptive 3-way blending using PixelMath

---

## Features

- Adaptive SNR-based resolution blending  
- Automatic superpixel generation (2x2)  
- Robust global intensity normalization  
- Smooth transition masks  
- Console progress reporting  
- Automatic cleanup of intermediate images  
- Designed for linear monochrome astrophotography workflows  

---

## Requirements

- PixInsight (recent versions)
- Linear monochrome images
- Drizzle and Normal integrations must be aligned
- A background preview for noise estimation

---

## User Controls

- **Analysis Area Size (px)** – Size of local region used for SNR analysis  
- **Low-SNR Areas to Smooth (%)** – Percentage of lowest-SNR regions assigned to superpixel smoothing  
- **High-SNR Areas for Drizzle (%)** – Percentage of highest-SNR regions assigned to drizzle dominance  
- **Transition Smoothness** – Feather strength for blending masks  

---

## Installation

1. Download the file:
