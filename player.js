// Walk/fly movement. Capsule-vs-BVH push-out is the three-mesh-bvh characterMovement example's;
// the capsule floats STEP above the feet and a down ray puts the feet on the floor, so low steps are climbed.
import { Vector3, Line3, Box3, Ray, DoubleSide } from 'three';

export const EYE = 1.6;
const R = 0.25, STEP = 0.3, HEAD = 1.75, GRAVITY = -20, WALK = 2, FLY = 3, CLIMB = 2, MARGIN = 0.03;

const seg = new Line3(), box = new Box3(), ray = new Ray(), triPt = new Vector3(), capPt = new Vector3();
const dir = new Vector3(), step = new Vector3(), wall = new Vector3(), nrm = new Vector3();

export class Player {
  pos = new Vector3(); // feet
  vy = 0;
  fly = false;
  grounded = false;
  lastFloor = null; // where the feet last stood, for climbing back out of a hole
  bvh = null; // MeshBVH of the world-space collider
  bounds = new Box3(); // of the collider

  // move: {x: right, y: forward} with length <= 1, up: -1..1, yaw: camera.
  // Moves stay level whatever the view pitch, flying too: a drone tilts its camera, not its course.
  // ponytail: no inertia, stops the moment the stick is let go; ease the speed if a drone-like glide is wanted
  update(dt, move, up, yaw) {
    // standing still on the floor: skip the shapecast, it costs ~1-2k triangle tests next to a dense scanned wall
    if (!this.fly && this.grounded && !move.x && !move.y) return;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    dir.set(move.x * c - move.y * s, 0, -move.x * s - move.y * c);
    // substeps well under the radius so thin walls and floors can't be skipped, falling included
    const n = Math.ceil((Math.max(WALK, Math.abs(this.vy) - GRAVITY * dt) * dt) / (R / 2));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.fly) {
        // it's a viewer, not a game: flying passes through walls, ceilings and floors alike; constraints live only in walking
        this.pos.addScaledVector(dir, FLY * h);
        this.pos.y += up * CLIMB * h;
        this.vy = 0;
        this.grounded = false;
        continue;
      }
      // don't walk into the wall we are already touching: on a noisy scanned wall the deep push-out
      // otherwise slides you sideways (measured ~1.3m in 5s of pushing at one step per frame)
      step.copy(dir);
      const into = step.dot(wall);
      if (into < 0) step.addScaledVector(wall, -into);
      this.pos.addScaledVector(step, WALK * h);
      this.vy += GRAVITY * h;
      this.pos.y += this.vy * h;
      if (this.bvh) this.collide();
    }
  }

  // first floor along the ray: a face turned up, with the eye still under the top of the scan, or low enough
  // to be ground and not a ceiling (a scan lower than the eye, a terrace or a floor only, has no headroom anywhere)
  floorAlong(ray) {
    for (let near = 0; ;) {
      const hit = this.bvh.raycastFirst(ray, DoubleSide, near);
      if (!hit) return null;
      const n = hit.face.normal, y = hit.point.y;
      if (n.dot(ray.direction) > 0) n.negate();
      if (n.y < 0.5) return null; // floors only
      if (y + EYE <= this.bounds.max.y || y < this.bounds.min.y + EYE) return hit;
      near = hit.distance + 0.01; // top of the ceiling seen from above it, top of a tall cupboard: look past it
    }
  }

  collide() {
    const p = this.pos;
    seg.start.set(p.x, p.y + STEP + R, p.z);
    seg.end.set(p.x, p.y + HEAD - R, p.z);
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end);
    box.min.addScalar(-R - MARGIN);
    box.max.addScalar(R + MARGIN);
    wall.set(0, 0, 0);
    this.bvh.shapecast({
      intersectsBounds: b => b.intersectsBox(box),
      intersectsTriangle: tri => {
        const d = tri.closestPointToSegment(seg, triPt, capPt);
        if (d >= R + MARGIN) return;
        const n = capPt.sub(triPt).normalize();
        tri.getNormal(nrm); // face normal, not n: n tilts at triangle edges and would steer you sideways
        wall.addScaledVector(nrm, nrm.dot(n) < 0 ? -1 : 1);
        if (d < R) {
          seg.start.addScaledVector(n, R - d);
          seg.end.addScaledVector(n, R - d);
        }
      },
    });
    wall.y = 0;
    wall.normalize(); // summed face normals of touched triangles: the average wall direction, zero when free
    p.set(seg.start.x, seg.start.y - STEP - R, seg.start.z);

    ray.origin.copy(seg.start);
    ray.direction.set(0, -1, 0);
    const hit = this.bvh.raycastFirst(ray, DoubleSide, 0, STEP + R + 0.05);
    this.grounded = !!hit && this.vy <= 0 && p.y <= hit.point.y + 0.02;
    if (this.grounded) {
      p.y = hit.point.y;
      this.vy = 0;
      (this.lastFloor ??= new Vector3()).copy(p);
    }
  }
}
