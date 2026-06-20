import cv2
import numpy as np
import os

def align_images(img_src, img_dst):
    """Align img_src to img_dst using ORB keypoint matching + homography."""
    gray_src = cv2.cvtColor(img_src, cv2.COLOR_BGR2GRAY)
    gray_dst = cv2.cvtColor(img_dst, cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(5000)
    kp_src, des_src = orb.detectAndCompute(gray_src, None)
    kp_dst, des_dst = orb.detectAndCompute(gray_dst, None)

    if des_src is None or des_dst is None:
        print("Feature matching failed, falling back to simple resize")
        return cv2.resize(img_src, (img_dst.shape[1], img_dst.shape[0]))

    matcher = cv2.DescriptorMatcher_create(cv2.DESCRIPTOR_MATCHER_BRUTEFORCE_HAMMING)
    matches = matcher.match(des_src, des_dst, None)
    matches = sorted(matches, key=lambda x: x.distance)

    good_matches = matches[:int(len(matches) * 0.15)]
    if len(good_matches) < 10:
        print("Too few good matches, falling back to simple resize")
        return cv2.resize(img_src, (img_dst.shape[1], img_dst.shape[0]))

    pts_src = np.float32([kp_src[m.queryIdx].pt for m in good_matches])
    pts_dst = np.float32([kp_dst[m.trainIdx].pt for m in good_matches])

    H, _ = cv2.findHomography(pts_src, pts_dst, cv2.RANSAC, 5.0)
    h, w = img_dst.shape[:2]
    return cv2.warpPerspective(img_src, H, (w, h))


def clip_weight(w):
    w = np.clip(w, 0.0, 1.0)
    return float(w ** 1.2)   # slightly gentler power curve for smoother mouth motion


def get_speech_weight(frame_idx, num_frames=3200):
    """
    Generate speech weight for speak frames.
    Instead of baking in pauses (which conflicts with real-time JS word boundary lip-sync),
    we generate a continuous articulating chatter.
    For 300 frames, we use a multi-frequency organic oscillation (cycle of 10 and 6 frames)
    for natural syllable variation. Both divide 300 perfectly, so looping is 100% seamless.
    """
    i = frame_idx
    if num_frames == 300:
        w = 0.45 + 0.25 * np.sin(2 * np.pi * i / 10) + 0.15 * np.sin(2 * np.pi * i / 6)
    else:
        cycle = 20 if num_frames == 3200 else 10
        w = 0.525 + 0.375 * np.sin(2 * np.pi * i / cycle)
    return clip_weight(w)


def get_idle_transform(i, num_frames=3200):
    """
    Return (dx, dy, angle) for breathing and head sway.
    Frequencies are adjusted to divide num_frames perfectly for seamless looping.
    At 60fps (3200 frames), the cycle lengths are doubled compared to 30fps to maintain the same timing.
    """
    if num_frames == 300:
        c_breath = 100
        c_breath_harm = 150
        c_sway = 300
        c_micro_sway = 75
        c_tilt = 300
        c_tilt_micro = 75
    elif num_frames == 3200:
        c_breath = 320          # 320 divides 3200 (10 cycles)
        c_breath_harm = 640     # 640 divides 3200 (5 cycles)
        c_sway = 800            # 800 divides 3200 (4 cycles)
        c_micro_sway = 200      # 200 divides 3200 (16 cycles)
        c_tilt = 1600           # 1600 divides 3200 (2 cycles)
        c_tilt_micro = 400      # 400 divides 3200 (8 cycles)
    elif num_frames == 1600:
        c_breath = 160
        c_breath_harm = 320
        c_sway = 400
        c_micro_sway = 100
        c_tilt = 800
        c_tilt_micro = 200
    else:
        # Fallback to 600-frame cycle lengths
        c_breath = 120
        c_breath_harm = 240
        c_sway = 300
        c_micro_sway = 100
        c_tilt = 400
        c_tilt_micro = 150

    # Breathing — primary (subtle vertical motion, amplitude reduced to 1.8)
    breath_primary = 1.8 * np.sin(2 * np.pi * i / c_breath)
    # Breathing — harmonic (amplitude reduced to 0.4)
    breath_harmonic = 0.4 * np.sin(2 * np.pi * i / c_breath_harm + 0.4)
    dy = breath_primary + breath_harmonic

    # Horizontal head sway (amplitude reduced to 1.5)
    sway = 1.5 * np.cos(2 * np.pi * i / c_sway)
    # Micro-sway overlay (amplitude reduced to 0.3)
    micro_sway = 0.3 * np.sin(2 * np.pi * i / c_micro_sway + 1.2)
    dx = sway + micro_sway

    # Head tilt (amplitude reduced to 0.25)
    tilt_primary = 0.25 * np.sin(2 * np.pi * i / c_tilt)
    # Micro-tilt (amplitude reduced to 0.05)
    tilt_micro = 0.05 * np.cos(2 * np.pi * i / c_tilt_micro + 0.8)
    angle = tilt_primary + tilt_micro

    return dx, dy, angle


def generate_animation_frames():
    closed_path = 'interviewer_closed.jpg'
    open_path   = 'interviewer_open.png'

    if not os.path.exists(closed_path) or not os.path.exists(open_path):
        print(f"Error: Missing source images '{closed_path}' or '{open_path}'")
        return

    img_closed = cv2.imread(closed_path)
    img_open   = cv2.imread(open_path)

    if img_closed is None or img_open is None:
        print("Error: Could not load images. Check file paths.")
        return

    print("Aligning open-mouth image to closed-mouth base...")
    img_aligned_open = align_images(img_open, img_closed)

    os.makedirs('avatar_idle',  exist_ok=True)
    os.makedirs('avatar_speak', exist_ok=True)

    num_frames = 300
    height, width = img_closed.shape[:2]

    # ── Body mask (person silhouette, keeps background static) ──────────────
    mask = np.zeros((height, width), dtype=np.float32)
    pts = np.array([
        [467,  180],   # Head top center
        [800,  520],   # Upper right shoulder
        [935,  800],   # Right arm bottom
        [935, 1024],   # Bottom right
        [  0, 1024],   # Bottom left
        [  0,  800],   # Left arm bottom
        [160,  520],   # Upper left shoulder
    ], dtype=np.int32)
    cv2.fillPoly(mask, [pts], 255)

    # Feather the mask edges (reduced to 61,61 to make outline crisper and avoid bleeding)
    mask_feathered = cv2.GaussianBlur(mask, (61, 61), 0) / 255.0
    mask_feathered = np.expand_dims(mask_feathered, axis=2)

    # ── Mouth mask (isolated mouth blending, prevents overall face blurring) ──
    # Center is (556, 589). We restore the large mask size to cover the entire mouth, lips, and chin movement.
    mouth_mask = np.zeros((height, width), dtype=np.float32)
    cv2.ellipse(mouth_mask, (556, 589), (88, 99), 0, 0, 360, 255, -1)
    mouth_mask_feathered = cv2.GaussianBlur(mouth_mask, (31, 31), 0) / 255.0
    mouth_mask_3d = np.expand_dims(mouth_mask_feathered, axis=2)

    center = (width / 2, height)

    print(f"Generating {num_frames} frames (idle + speak) with crisp motion & local lip sync...")

    # Crop mouth region (expanded coordinates so the large mouth mask fades to exactly 0 at the crop edges)
    ymin, ymax = 449, 729
    xmin, xmax = 426, 686
    crop_closed = img_closed[ymin:ymax, xmin:xmax].astype(np.float32)
    crop_open = img_aligned_open[ymin:ymax, xmin:xmax].astype(np.float32)
    crop_mask = mouth_mask_3d[ymin:ymax, xmin:xmax]

    print("Computing dense optical flow for high-precision mouth morphing...")
    gray_closed = cv2.cvtColor(crop_closed.astype(np.uint8), cv2.COLOR_BGR2GRAY)
    gray_open = cv2.cvtColor(crop_open.astype(np.uint8), cv2.COLOR_BGR2GRAY)

    flow_to_open = cv2.calcOpticalFlowFarneback(
        gray_closed, gray_open, None,
        pyr_scale=0.5, levels=5, winsize=13,
        iterations=10, poly_n=5, poly_sigma=1.1, flags=0
    )
    flow_to_closed = cv2.calcOpticalFlowFarneback(
        gray_open, gray_closed, None,
        pyr_scale=0.5, levels=5, winsize=13,
        iterations=10, poly_n=5, poly_sigma=1.1, flags=0
    )

    h_crop, w_crop = crop_closed.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(w_crop), np.arange(h_crop))
    grid_x = grid_x.astype(np.float32)
    grid_y = grid_y.astype(np.float32)

    for i in range(num_frames):
        dx, dy, angle = get_idle_transform(i, num_frames)

        # Build the affine warp matrix
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        M[0, 2] += dx
        M[1, 2] += dy

        # ── IDLE frame ────────────────────────────────────────────────────────
        # Warp the closed face
        warped_closed = cv2.warpAffine(
            img_closed, M, (width, height),
            borderMode=cv2.BORDER_REPLICATE
        )
        # Apply body mask to blend with static background
        frame_idle = (warped_closed * mask_feathered
                      + img_closed * (1.0 - mask_feathered))
        
        cv2.imwrite(
            f'avatar_idle/frame_{i}.jpg',
            frame_idle.astype(np.uint8),
            [int(cv2.IMWRITE_JPEG_QUALITY), 95]  # Higher quality to eliminate compression blur
        )

        # ── SPEAK frame ───────────────────────────────────────────────────────
        w = get_speech_weight(i, num_frames)
        # Warp crops forward and backward using dense optical flow maps
        map1_x = grid_x - w * flow_to_open[..., 0]
        map1_y = grid_y - w * flow_to_open[..., 1]
        warped_closed_crop = cv2.remap(crop_closed, map1_x, map1_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

        map2_x = grid_x - (1.0 - w) * flow_to_closed[..., 0]
        map2_y = grid_y - (1.0 - w) * flow_to_closed[..., 1]
        warped_open_crop = cv2.remap(crop_open, map2_x, map2_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

        # Blend perfectly aligned morphed mouth shapes
        morphed_combination = warped_closed_crop * (1.0 - w) + warped_open_crop * w
        
        # Feather blend morphed mouth back onto the static base face using the mouth mask
        crop_blended = crop_closed * (1.0 - crop_mask) + morphed_combination * crop_mask
        blended = img_closed.copy()
        blended[ymin:ymax, xmin:xmax] = crop_blended.astype(np.uint8)

        # Warp the blended face
        warped_speak = cv2.warpAffine(
            blended, M, (width, height),
            borderMode=cv2.BORDER_REPLICATE
        )
        # Apply body mask to blend with static background
        frame_speak = (warped_speak * mask_feathered
                       + img_closed * (1.0 - mask_feathered))
        
        cv2.imwrite(
            f'avatar_speak/frame_{i}.jpg',
            frame_speak.astype(np.uint8),
            [int(cv2.IMWRITE_JPEG_QUALITY), 95]  # Higher quality to eliminate compression blur
        )

        if i % 320 == 0:
            pct = int(i / num_frames * 100)
            print(f"  [{pct:3d}%] {i}/{num_frames} frames done")

    print(f"\nDone! Generated {num_frames} idle + {num_frames} speak frames.")
    print("avatar_idle/  and  avatar_speak/  are ready.")


if __name__ == '__main__':
    generate_animation_frames()
