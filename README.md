# tilt-lab

Static test pages for a phone game, opened on a phone (motion sensors need https):
- https://actiontakers.github.io/tilt-lab/s1-tilt/ : tilt steering. Five steering signals compared on a small buoy slalom, with
  sensor rates, noise, lag, and screen and sound checks.
- https://actiontakers.github.io/tilt-lab/s2-water/ : water. Eight steps of water, from flat to everything on, each measured for how
  much drawing the phone has left at its refresh rate.
- https://actiontakers.github.io/tilt-lab/s3-feel/ : boat feel. A greybox boat on the same waves, steered by tilting the phone: two
  boats, three cameras, a rival, a buoy course with a moored yacht beside it; each lap scored, and its steering recorded so it can
  be played back.

Nothing leaves the phone unless you copy or download the results yourself.

This repository only publishes the pages. vendor/three-0.186.1 is three.js (MIT licence, see its LICENSE file), unchanged.
s3-feel/assets/yacht-b04.glb is a 3D model generated with Tripo from the project owner's own picture, then reduced in Blender.
S1 published 2026-11-06; S2 and S3 added 2026-11-08; S1 v0.4 and S3 v0.2 (the yacht) on 2026-11-13.
