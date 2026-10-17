"""Synthetic textured room as USDZ with a binary USDC root layer. Usage: python make_room.py OUT_DIR

Room 6m (x) x 5m (z), walls 2.6m, door gap (0.9m x 2.1m) in the +z wall,
box obstacle 1m cube at (1.8, 0, -1.2), step 0.18m platform at x in [-3,-1.5], z in [-2.5,-0.5].
Outputs: room_y.usdz (upAxis Y), room_z.usdz (Z-up geometry, upAxis Z),
room_z_mislabeled.usdz (Z-up geometry, upAxis Y declared), room_cm.usdz (centimetres, metersPerUnit 0.01).
"""
import os, sys, zipfile
from PIL import Image, ImageDraw
from pxr import Usd, UsdGeom, UsdShade, Sdf, UsdUtils, Gf

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

# texture atlas: 4 quadrants (floor, wall, box, step)
S = 512
img = Image.new('RGB', (S, S))
d = ImageDraw.Draw(img)
quads = {'floor': (0, 0, (150, 100, 60)), 'wall': (1, 0, (210, 200, 180)),
         'box': (0, 1, (60, 90, 170)), 'step': (1, 1, (70, 150, 80))}
for name, (qx, qy, (r, g, b)) in quads.items():
    for i in range(8):
        for j in range(8):
            k = 1.0 if (i + j) % 2 else 0.75
            x0, y0 = qx * 256 + i * 32, qy * 256 + j * 32
            d.rectangle([x0, y0, x0 + 31, y0 + 31], fill=(int(r * k), int(g * k), int(b * k)))
    d.rectangle([qx * 256, qy * 256, qx * 256 + 255, qy * 256 + 255], outline=(20, 20, 20), width=3)
tex = os.path.join(out, 'texture.png')
img.save(tex)

def uvq(name):  # UV rect of a quadrant; PNG row 0 is top, USD v=0 is bottom
    qx, qy, _ = quads[name]
    u0, u1 = qx * 0.5 + 0.01, qx * 0.5 + 0.49
    v1 = 1 - qy * 0.5 - 0.01
    v0 = 1 - qy * 0.5 - 0.49
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]

pts, counts, idx, st = [], [], [], []
def quad(a, b, c, e, name):
    base = len(pts)
    pts.extend([a, b, c, e])
    counts.append(4)
    idx.extend([base, base + 1, base + 2, base + 3])
    st.extend(uvq(name))

def box(x0, y0, z0, x1, y1, z1, name):  # outward faces
    quad((x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0), name)  # top
    quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), name)  # +z
    quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), name)  # -z
    quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), name)  # +x
    quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0), name)  # -x

X, Z, H = 3.0, 2.5, 2.6
# floor (facing up) and ceiling (facing down)
quad((-X, 0, Z), (X, 0, Z), (X, 0, -Z), (-X, 0, -Z), 'floor')
quad((-X, H, -Z), (X, H, -Z), (X, H, Z), (-X, H, Z), 'wall')
# walls facing inward
quad((-X, 0, -Z), (X, 0, -Z), (X, H, -Z), (-X, H, -Z), 'wall')   # -z wall
quad((X, 0, -Z), (X, 0, Z), (X, H, Z), (X, H, -Z), 'wall')       # +x wall
quad((-X, 0, Z), (-X, 0, -Z), (-X, H, -Z), (-X, H, Z), 'wall')   # -x wall
# +z wall with door gap x in [-0.45, 0.45], height 2.1
quad((X, 0, Z), (0.45, 0, Z), (0.45, H, Z), (X, H, Z), 'wall')
quad((-0.45, 0, Z), (-X, 0, Z), (-X, H, Z), (-0.45, H, Z), 'wall')
quad((0.45, 2.1, Z), (-0.45, 2.1, Z), (-0.45, H, Z), (0.45, H, Z), 'wall')
# a bit of floor outside the door so you can walk out
quad((-1.0, 0, Z + 1.5), (1.0, 0, Z + 1.5), (1.0, 0, Z), (-1.0, 0, Z), 'floor')
box(1.3, 0, -1.7, 2.3, 1.0, -0.7, 'box')
box(-3.0, 0, -2.5, -1.5, 0.18, -0.5, 'step')

def write(name, up, mpu, transform):
    layer = os.path.join(out, name + '.usdc')
    stage = Usd.Stage.CreateNew(layer)
    UsdGeom.SetStageUpAxis(stage, up)
    UsdGeom.SetStageMetersPerUnit(stage, mpu)
    root = UsdGeom.Xform.Define(stage, '/Room')
    stage.SetDefaultPrim(root.GetPrim())
    mesh = UsdGeom.Mesh.Define(stage, '/Room/Scan')
    mesh.CreatePointsAttr([Gf.Vec3f(*transform(p)) for p in pts])
    mesh.CreateFaceVertexCountsAttr(counts)
    mesh.CreateFaceVertexIndicesAttr(idx)
    mesh.CreateSubdivisionSchemeAttr('none')
    pv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar('st', Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying)
    pv.Set([Gf.Vec2f(*u) for u in st])
    mat = UsdShade.Material.Define(stage, '/Room/Looks/Mat')
    sh = UsdShade.Shader.Define(stage, '/Room/Looks/Mat/PBR')
    sh.CreateIdAttr('UsdPreviewSurface')
    sh.CreateInput('roughness', Sdf.ValueTypeNames.Float).Set(1.0)
    rd = UsdShade.Shader.Define(stage, '/Room/Looks/Mat/st')
    rd.CreateIdAttr('UsdPrimvarReader_float2')
    rd.CreateInput('varname', Sdf.ValueTypeNames.Token).Set('st')
    tx = UsdShade.Shader.Define(stage, '/Room/Looks/Mat/Tex')
    tx.CreateIdAttr('UsdUVTexture')
    tx.CreateInput('file', Sdf.ValueTypeNames.Asset).Set('texture.png')
    tx.CreateInput('st', Sdf.ValueTypeNames.Float2).ConnectToSource(rd.ConnectableAPI(), 'result')
    tx.CreateOutput('rgb', Sdf.ValueTypeNames.Float3)
    sh.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).ConnectToSource(tx.ConnectableAPI(), 'rgb')
    mat.CreateSurfaceOutput().ConnectToSource(sh.ConnectableAPI(), 'surface')
    UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mat)
    stage.GetRootLayer().Save()
    usdz = os.path.join(out, name + '.usdz')
    assert UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(layer), usdz)
    with zipfile.ZipFile(usdz) as z:
        first = z.namelist()[0]
        assert first.endswith('.usdc') and z.read(first)[:8] == b'PXR-USDC', first
    print(usdz, os.path.getsize(usdz))

zup = lambda p: (p[0], -p[2], p[1])  # Y-up -> Z-up (rotate +90 deg about X)
write('room_y', UsdGeom.Tokens.y, 1.0, lambda p: p)
write('room_z', UsdGeom.Tokens.z, 1.0, zup)
write('room_z_mislabeled', UsdGeom.Tokens.y, 1.0, zup)
write('room_cm', UsdGeom.Tokens.y, 0.01, lambda p: tuple(c * 100 for c in p))
