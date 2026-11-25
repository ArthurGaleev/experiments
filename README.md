# Floor plan from photos: experiments

Interactive galleries for research toward a floor plan from sparse photographs.
[Open the catalog](https://arthurgaleev.github.io/experiments/) or
[inspect all photos in 3D](https://arthurgaleev.github.io/experiments/alignment/clouds/all-photos.html).
These are tool experiments, not a completed apartment plan.

## What is available

| Experiment | Contribution |
|---|---|
| [SIFT](https://arthurgaleev.github.io/experiments/sift/) | Classical keypoints, correspondences and pair matrix |
| [RoMa v2 / SIFT](https://arthurgaleev.github.io/experiments/roma/) | All 253 photo pairs, match coverage and graph diagnostics |
| [MetricAnything / MoGe-2](https://arthurgaleev.github.io/experiments/depth/) | Per-photo depth and interactive clouds with a shared comparison view |
| [GeoCalib](https://arthurgaleev.github.io/experiments/geocalib/) | Vertical direction, calibration and before/after leveling |
| [Alignment](https://arthurgaleev.github.io/experiments/alignment/) | Four matcher × depth branches with independent edges, poses, cycles and failures |
| [Planar patches](https://arthurgaleev.github.io/experiments/planes/) | Experimental depth approximation, image support and point/patch views |
| [Qwen edge review](https://arthurgaleev.github.io/experiments/alignment/grouping/) | Saved photo observations and all 253 pairs in both orders |
| [Room/doorway hypotheses](https://arthurgaleev.github.io/experiments/alignment/grouping/rooms.html) | Alternatives, contradictions and reconstruction candidates |
| [Connection recovery](https://arthurgaleev.github.io/experiments/alignment/grouping/recovery.html) | Validated component bridges, scale corrections and path checks |
| [Global Qwen](https://arthurgaleev.github.io/experiments/alignment/grouping/global.html) | All-photo room reasoning, revisions and repeat/order differences |
| [Joint DA3-Small](https://arthurgaleev.github.io/experiments/da3/) | Shared cameras and depth within groups of 20, 2 and 1 photos |
| [Individual geometry · G1](https://arthurgaleev.github.io/experiments/individual_geometry/) | MetricAnything, MoGe-2/3, DA3 metric depth and independent camera calibration, with one shared photo/3D browser |

The viewer retains all photos, including singletons. Selecting photos changes
visibility while preserving established poses. Originally disconnected components
have unknown relative placement. The Three.js viewer loads detail on demand,
starting at 100k points per photo. Detail offers only useful counts, followed by
**All saved** with the saved maximum shown. The
all-photo view defaults to RoMa + MoGe-2 with VLM review and supported recovery.
Matcher/depth, VLM review, supported recovery and semantic room
source select separately saved results; the browser runs no inference.

The G1 gallery compares individual photo geometry before alignment and starts at
25k points per photo. Its model selector changes saved depth/calibration variants;
it does not claim those clouds share an apartment coordinate frame. The local
development report uses the same viewer and adds dataset/scene navigation and
reference comparisons. Only the bundled Blueprint sample is published here.

**Compare models** shows one photo across up to four models in a linked grid.
Rotation, pan and zoom move together; common bounds preserve scale differences.
This compares each photo's local depth/shape before scene placement. Return to
scene restores the existing reconstruction. G1's All saved means its 25k display
sample; the older depth/alignment galleries retain full saved point clouds.

In Inspect, drag to orbit, Shift/right-drag to pan, scroll/pinch to zoom, and double-click a
surface to focus. The compact toolbar provides View, Display, Section, Rulers
and Saved views panels. Use the orientation widget or presets for top/front/side
and isometric views; switch between perspective and orthographic projection
without losing the apparent zoom. Fit/reset fits the current group.

Explore opens one aligned group at a predicted photo camera. Drag to look,
WASD/arrows to move, Q/E to change height, and Shift to move faster. Phones have
a movement pad and height buttons. Movement keeps its speed inside rooms; it does
not depend on orbit distance. View → Photo viewpoint, or Viewpoint below a thumbnail,
jumps to that photo's position and direction. Open photo shows the source image.
Returning to Inspect restores the previous overview. Viewpoints are upright;
photo framing can differ. There is no floor snapping or wall collision detection.
Unrelated components remain separate; a jump is not a verified walkable route.

Height cutaway hides upper surfaces. Cross-section keeps a movable band with an
adjustable width and horizontal, vertical or custom orientation. Both controls
clip points and patches consistently; rulers and camera annotations stay visible.
Slice width is a display setting, not an estimate of physical wall thickness.
On mobile, Adjust with scene visible reduces settings to a bottom strip for
position, width, cutaway height or point size. The canvas stays unobscured while
adjusting. Rendering diagnostics stay outside enlarged mode; brief Inspection tips
explain useful combinations of orientation, projection and slices.

Open Rulers, enable Measure distance and click A then B to add rulers, with distance labels on their
lines and source-photo names in the toolbar. Points/Both snap to saved vertices;
Patches measures between positions inside finite fitted triangles. Select a ruler
for 3D, horizontal and vertical distances. Drag A/B to adjust it, or click an
endpoint and then its new position. Delete rulers individually or clear all;
Escape cancels unfinished picks/edits. Metres/centimetres follow predicted scale;
DA3 retains relative units. Cross-component distances remain unavailable.

Saved views preserve selection, reconstruction branch, camera, navigation mode, display/clipping
and completed rulers. Save them in this browser, or copy a portable view link
for the same scene. View links contain settings, not cloud files or server writes.
Hover a camera outline to highlight it, then click/tap to open its source photo.
Rendering diagnostics sit below the regular scenes. These static tools also work locally
through an HTTP server, without a backend or model inference.

The preferred 20-photo scene requests about 30 MB of geometry at 100k/photo or
78.4 MB at Full; other page assets add overhead. Controls reuse loaded geometry.
GitHub Pages currently documents a 1 GB site limit and 100 GB/month soft bandwidth
limit; see [GitHub's limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
Actual usage depends on visitors, selected detail and caching.

A geometric component is not a room. Pairwise room hypotheses can overlap and are
not a room count. Global Qwen's five-room proposals are also unverified; repeated
agreement does not establish correctness. Rooms visible through openings can
have supporting photos without an assigned camera or reconstructed geometry.
Unaligned room parts are arranged for inspection, with no physical inter-part
distance implied.

VLM review can remove a false bridge and recompute placement. Supported recovery
uses both positive visual landmarks and validated scale-aware geometry, applying
one transform per original component. Internal relative poses are retained.
This does not perform joint camera/depth optimization or surface fusion. DA3
predicts joint geometry with independent relative scale per group, including
local depth for singletons. Original and processed RGB show actual cropping.

## Evidence and limitations

There are no verified camera poses or depth for this house. Graph size, inlier
counts, model agreement and attractive clouds are not accuracy scores. For example,
the original SIFT branches accept 5/7 pairs and RoMa 26/37, but 197 SIFT pairs
lack enough support for the common fit/validation split. This is not an accuracy
ranking. A manually noted false white-corner alignment remains visible; that note
was not supplied to Qwen and did not alter the baseline decisions.

Saved Qwen evidence covers all 23 photos and 253 pairs in both image orders,
plus two pair repeats and three global calls (forward, reverse and repeat).
All 531 photo/pair responses and three global responses passed schema validation
and contain English descriptive text. Global camera-room assignments agree across
the three calls, while doorway certainty and revision explanations still vary.
Independent dev scorecards and private datasets remain in the source workspace.
Full NPZ arrays are local; galleries stream saved geometry at the selected detail,
including all valid points at Full, and need no compute server. One selected run
per tool is exported here.

## Data and license

Photos come from the [official Andon Labs Blueprint-Bench example](https://github.com/AndonLabs/Blueprint-Bench-generation/tree/6e9b9a62eeb5dc0a43718045a2b1e79b41725eaa/dataset/example_house).
Five collages were manually split, removing separator strips, and files were
renamed: 18 original JPEGs became 23 photos. This is a smoke sample, not the
private full benchmark. [Apache-2.0 license](LICENSE), as in the source repository.

## Maintenance

Generators and checks live in [photo2plan](https://github.com/ArthurGaleev/photo2plan).
From that source checkout, `uv run python scripts/refresh_experiments.py --export`
stages selected runs, rerenders and verifies preserved data before replacing
presentation files. Then run
`uv run python scripts/check_gallery.py outputs/experiments --public`.
No model inference, commit or push is performed by those commands. This is a
separate Git repository; publishing its prepared changes is a separate action.
