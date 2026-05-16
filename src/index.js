import * as THREE from 'three';
import { BufferGeometry, Color, Float32BufferAttribute, Vector3 } from 'three';
// TeamSync fork: switched from the vendored OrbitControls (vintage 2016,
// listens for `mousewheel` not `wheel`, drags die when the cursor leaves
// the canvas) to the modern OrbitControls shipped with three.js. The
// modern one uses pointer events, listens on window for move/up so
// drags survive cursor escape, and supports touch + Safari trackpads.
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import bSpline from './bspline';
// TeamSync fork: troika-three-text + @dxfom/mtext were removed because
// they transitively depend on three-core symbols (CylinderBufferGeometry,
// PlaneBufferGeometry) that were dropped in three >=0.137. TEXT / MTEXT
// entities are now skipped silently -- 3D drafting drawings render
// without text labels, but lines/faces/solids are unaffected. If text
// support is needed later, vendor in a modern troika-three-text or
// switch to three-stdlib's TextGeometry.

const textControlCharactersRegex = /\\[AXQWOoLIpfH].*;/g;
const curlyBraces = /\\[{}]/g;

// Three.js extension functions. Webpack doesn't seem to like it if we modify the THREE object directly.
var THREEx = { Math: {} };
/**
 * Returns the angle in radians of the vector (p1,p2). In other words, imagine
 * putting the base of the vector at coordinates (0,0) and finding the angle
 * from vector (1,0) to (p1,p2).
 * @param  {Object} p1 start point of the vector
 * @param  {Object} p2 end point of the vector
 * @return {Number} the angle
 */
THREEx.Math.angle2 = function (p1, p2) {
    var v1 = new THREE.Vector2(p1.x, p1.y);
    var v2 = new THREE.Vector2(p2.x, p2.y);
    v2.sub(v1); // sets v2 to be our chord
    v2.normalize();
    if (v2.y < 0) return -Math.acos(v2.x);
    return Math.acos(v2.x);
};


THREEx.Math.polar = function (point, distance, angle) {
    var result = {};
    result.x = point.x + distance * Math.cos(angle);
    result.y = point.y + distance * Math.sin(angle);
    return result;
};

/**
 * Calculates points for a curve between two points using a bulge value. Typically used in polylines.
 * @param startPoint - the starting point of the curve
 * @param endPoint - the ending point of the curve
 * @param bulge - a value indicating how much to curve
 * @param segments - number of segments between the two given points
 */
function getBulgeCurvePoints(startPoint, endPoint, bulge, segments) {

    var vertex, i,
        center, p0, p1, angle,
        radius, startAngle,
        thetaAngle;

    var obj = {};
    obj.startPoint = p0 = startPoint ? new THREE.Vector2(startPoint.x, startPoint.y) : new THREE.Vector2(0, 0);
    obj.endPoint = p1 = endPoint ? new THREE.Vector2(endPoint.x, endPoint.y) : new THREE.Vector2(1, 0);
    obj.bulge = bulge = bulge || 1;

    angle = 4 * Math.atan(bulge);
    radius = p0.distanceTo(p1) / 2 / Math.sin(angle / 2);
    center = THREEx.Math.polar(startPoint, radius, THREEx.Math.angle2(p0, p1) + (Math.PI / 2 - angle / 2));

    obj.segments = segments = segments || Math.max(Math.abs(Math.ceil(angle / (Math.PI / 18))), 6); // By default want a segment roughly every 10 degrees
    startAngle = THREEx.Math.angle2(center, p0);
    thetaAngle = angle / segments;

    var vertices = [];

    // TeamSync fork: preserve Z from the start/end of the bulge arc.
    // Bulges are 2D by definition (arcs in the XY plane of the parent
    // polyline), so we linearly interpolate Z from start to end. For a
    // typical extruded polyline this keeps the curve coplanar with the
    // rest of the polyline at its elevation.
    var z0 = startPoint && startPoint.z ? startPoint.z : 0;
    var z1 = endPoint && endPoint.z ? endPoint.z : z0;

    vertices.push(new THREE.Vector3(p0.x, p0.y, z0));

    for (i = 1; i <= segments - 1; i++) {
        vertex = THREEx.Math.polar(center, Math.abs(radius), startAngle + thetaAngle * i);
        var t = i / segments;
        vertices.push(new THREE.Vector3(vertex.x, vertex.y, z0 + (z1 - z0) * t));
    }

    return vertices;
};

/**
 * Viewer class for a dxf object.
 * @param {Object} data - the dxf object
 * @param {Object} parent - the parent element to which we attach the rendering canvas
 * @param {Number} width - width of the rendering canvas in pixels
 * @param {Number} height - height of the rendering canvas in pixels
 * @param {Object} font - a font loaded with THREE.FontLoader 
 * @constructor
 */
export function Viewer(data, parent, width, height, font) {

    createLineTypeShaders(data);

    var scene = new THREE.Scene();

    // Create scene from dxf object (data)
    var i, entity, obj, min_x, min_y, min_z, max_x, max_y, max_z;
    var dims = {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 }
    };
    for (i = 0; i < data.entities.length; i++) {
        entity = data.entities[i];
        obj = drawEntity(entity, data);

        if (obj) {
            var bbox = new THREE.Box3().setFromObject(obj);
            if (isFinite(bbox.min.x) && (dims.min.x > bbox.min.x)) dims.min.x = bbox.min.x;
            if (isFinite(bbox.min.y) && (dims.min.y > bbox.min.y)) dims.min.y = bbox.min.y;
            if (isFinite(bbox.min.z) && (dims.min.z > bbox.min.z)) dims.min.z = bbox.min.z;
            if (isFinite(bbox.max.x) && (dims.max.x < bbox.max.x)) dims.max.x = bbox.max.x;
            if (isFinite(bbox.max.y) && (dims.max.y < bbox.max.y)) dims.max.y = bbox.max.y;
            if (isFinite(bbox.max.z) && (dims.max.z < bbox.max.z)) dims.max.z = bbox.max.z;
            scene.add(obj);
        }
        obj = null;
    }

    width = width || parent.clientWidth;
    height = height || parent.clientHeight;
    var aspectRatio = width / height;

    var upperRightCorner = { x: dims.max.x, y: dims.max.y };
    var lowerLeftCorner = { x: dims.min.x, y: dims.min.y };

    // Figure out the current viewport extents
    var vp_width = upperRightCorner.x - lowerLeftCorner.x;
    var vp_height = upperRightCorner.y - lowerLeftCorner.y;
    var center = center || {
        x: vp_width / 2 + lowerLeftCorner.x,
        y: vp_height / 2 + lowerLeftCorner.y
    };

    // Fit all objects into current ThreeDXF viewer
    var extentsAspectRatio = Math.abs(vp_width / vp_height);
    if (aspectRatio > extentsAspectRatio) {
        vp_width = vp_height * aspectRatio;
    } else {
        vp_height = vp_width / aspectRatio;
    }

    var viewPort = {
        bottom: -vp_height / 2,
        left: -vp_width / 2,
        top: vp_height / 2,
        right: vp_width / 2,
        center: {
            x: center.x,
            y: center.y
        }
    };

    // TeamSync fork: widen the near/far frustum from (1, 19) to
    // (-100000, 100000). The original (1, 19) was tuned for top-down 2D
    // viewing where Z always sits near 0. Once we orbit, the camera
    // moves off-axis and parts of the scene end up beyond Z=19 (or
    // behind Z=1) and disappear. A huge symmetric range keeps every
    // entity in the frustum at every orbit angle.
    var camera = new THREE.OrthographicCamera(viewPort.left, viewPort.right, viewPort.top, viewPort.bottom, -100000, 100000);
    // TeamSync fork: nudge the camera off the polar axis so an initial
    // left-drag actually rotates. Starting at (cx, cy, 10) directly
    // above the target (cx, cy, 0) puts the camera at the OrbitControls
    // spherical singularity -- horizontal drags do nothing and vertical
    // drags get clamped at phi=0. Offsetting by a small tilt away from
    // the +Z axis breaks the degeneracy without visibly changing the
    // initial top-down framing.
    var modelDiagonal = Math.max(
        Math.abs(viewPort.right - viewPort.left),
        Math.abs(viewPort.top - viewPort.bottom)
    );
    var tilt = modelDiagonal * 0.001; // ~0.1% of the scene diagonal
    camera.position.x = viewPort.center.x;
    camera.position.y = viewPort.center.y - tilt;
    camera.position.z = modelDiagonal;

    var renderer = this.renderer = new THREE.WebGLRenderer();
    renderer.setSize(width, height);
    renderer.setClearColor(0xfffffff, 1);

    parent.appendChild(renderer.domElement);
    parent.style.display = 'block';

    // TeamSync fork: attach OrbitControls to the renderer's canvas
    // (not the parent div) so pointer events come straight from the
    // WebGL surface; avoids being blocked by overlay siblings.
    var controls = new OrbitControls(camera, renderer.domElement);
    controls.target.x = camera.position.x;
    controls.target.y = camera.position.y;
    controls.target.z = 0;
    controls.zoomSpeed = 3;
    // Enable rotation (default) + screen-space panning for an
    // orthographic camera so right-drag pans intuitively in pixel space.
    controls.enableRotate = true;
    controls.screenSpacePanning = true;

    //Uncomment this to disable rotation (does not make much sense with 2D drawings).
    //controls.enableRotate = false;

    this.render = function () { renderer.render(scene, camera) };
    controls.addEventListener('change', this.render);
    this.render();
    controls.update();

    // TeamSync fork: expose scene/camera/controls so consumers can
    // implement section-box clipping, 3D pin projection, distance
    // measurement, etc. Upstream kept these in a private closure -- not
    // friendly for any review-tool extension.
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    // Convenience: enable runtime clipping plane support. Materials
    // declare which planes they respect; with this flag off, any
    // clippingPlanes setting is silently ignored.
    renderer.localClippingEnabled = true;

    this.resize = function (width, height) {
        var originalWidth = renderer.domElement.width;
        var originalHeight = renderer.domElement.height;

        var hscale = width / originalWidth;
        var vscale = height / originalHeight;


        camera.top = (vscale * camera.top);
        camera.bottom = (vscale * camera.bottom);
        camera.left = (hscale * camera.left);
        camera.right = (hscale * camera.right);

        //        camera.updateProjectionMatrix();

        renderer.setSize(width, height);
        renderer.setClearColor(0xfffffff, 1);
        this.render();
    };

    function drawEntity(entity, data) {
        var mesh;
        if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
            mesh = drawArc(entity, data);
        } else if (entity.type === 'POLYLINE' && entity.isPolyfaceMesh) {
            // TeamSync fork: POLYFACE_MESH is a POLYLINE variant
            // (flag bit 64) whose vertices interleave mesh-vertices
            // and face-records. Renders as a triangle mesh, not a
            // wireframe -- drawLine would only show edges.
            mesh = drawPolyfaceMesh(entity, data);
        } else if (entity.type === 'LWPOLYLINE' || entity.type === 'LINE' || entity.type === 'POLYLINE') {
            mesh = drawLine(entity, data);
        } else if (entity.type === 'TEXT') {
            // TeamSync fork: text rendering disabled (see top-of-file note).
            mesh = null;
        } else if (entity.type === 'SOLID') {
            mesh = drawSolid(entity, data);
        } else if (entity.type === 'POINT') {
            mesh = drawPoint(entity, data);
        } else if (entity.type === 'INSERT') {
            mesh = drawBlock(entity, data);
        } else if (entity.type === 'SPLINE') {
            mesh = drawSpline(entity, data);
        } else if (entity.type === 'MTEXT') {
            // TeamSync fork: text rendering disabled (see top-of-file note).
            mesh = null;
        } else if (entity.type === 'ELLIPSE') {
            mesh = drawEllipse(entity, data);
        } else if (entity.type === 'DIMENSION') {
            var dimTypeEnum = entity.dimensionType & 7;
            if (dimTypeEnum === 0) {
                mesh = drawDimension(entity, data);
            } else {
                console.log("Unsupported Dimension type: " + dimTypeEnum);
            }
        } else if (entity.type === '3DFACE') {
            // TeamSync fork: render 3DFACE entities as triangle pairs.
            // 3DFACE has 3 or 4 vertices forming a flat face in 3D space;
            // dxf-parser exposes them via entity.vertices.
            mesh = draw3DFace(entity, data);
        }
        else {
            console.log("Unsupported Entity Type: " + entity.type);
        }
        return mesh;
    }

    // TeamSync fork: render a DXF 3DFACE entity (3 or 4 vertices in 3D
    // space defining a planar face) as a triangle (or two triangles for
    // a quad). drawSolid() uses a hardcoded 4-vertex pattern aimed at
    // SOLID (2D filled quad); 3DFACE differs in that its vertices have
    // arbitrary Z coords and the entity can degenerate to a triangle
    // when the 3rd and 4th vertices coincide -- handle both cases.
    // TeamSync fork: render a POLYFACE_MESH (POLYLINE with flag bit 64
    // set; isPolyfaceMesh=true in dxf-parser's output). Its `vertices`
    // array interleaves two kinds of records:
    //   - Mesh vertices: polyfaceMeshVertex=false, carrying x/y/z.
    //   - Face records:  polyfaceMeshVertex=true, carrying faceA..D
    //                    as 1-based indices into the mesh-vertex list.
    // Per DXF spec, negative indices indicate hidden edges; we ignore
    // that flag for v1 -- faces still render solid.
    function drawPolyfaceMesh(entity, data) {
        if (!entity.vertices || entity.vertices.length === 0) return null;
        var meshVerts = [];
        var faces = [];
        for (var i = 0; i < entity.vertices.length; i++) {
            var v = entity.vertices[i];
            if (v.polyfaceMeshVertex) {
                faces.push(v);
            } else {
                meshVerts.push(v);
            }
        }
        if (meshVerts.length < 3 || faces.length === 0) return null;
        var verts = [];
        function vertAt(idx) {
            // 1-based; absolute value for hidden-edge negatives.
            var n = Math.abs(idx) - 1;
            return meshVerts[n] || null;
        }
        for (var j = 0; j < faces.length; j++) {
            var f = faces[j];
            var p0 = vertAt(f.faceA);
            var p1 = vertAt(f.faceB);
            var p2 = vertAt(f.faceC);
            var p3 = f.faceD ? vertAt(f.faceD) : null;
            if (!p0 || !p1 || !p2) continue;
            // First triangle.
            addTriangleFacingCamera(verts, p0, p1, p2);
            // Second triangle for quad faces (when faceD is set and
            // refers to a distinct vertex). Many polyface meshes use
            // faceD=0 or faceD=faceC to mean "triangle, not quad".
            if (p3 && p3 !== p2 && f.faceD !== 0 && f.faceD !== f.faceC) {
                addTriangleFacingCamera(verts, p0, p2, p3);
            }
        }
        if (verts.length === 0) return null;
        var geometry = new THREE.BufferGeometry();
        geometry.setFromPoints(verts);
        var material = new THREE.MeshBasicMaterial({
            color: getColor(entity, data),
            side: THREE.DoubleSide,
        });
        return new THREE.Mesh(geometry, material);
    }

    function draw3DFace(entity, data) {
        if (!entity.vertices || entity.vertices.length < 3) return null;
        var verts = [];
        var p0 = entity.vertices[0];
        var p1 = entity.vertices[1];
        var p2 = entity.vertices[2];
        var p3 = entity.vertices[3] || p2;
        addTriangleFacingCamera(verts, p0, p1, p2);
        // Only emit the second triangle if it's distinct (non-degenerate quad).
        if (p3 !== p2 && (p3.x !== p2.x || p3.y !== p2.y || p3.z !== p2.z)) {
            addTriangleFacingCamera(verts, p0, p2, p3);
        }
        var geometry = new THREE.BufferGeometry();
        geometry.setFromPoints(verts);
        // DoubleSide so the face renders from either orbit angle (3DFACE
        // doesn't carry a consistent winding-order convention across
        // CAD tools).
        var material = new THREE.MeshBasicMaterial({
            color: getColor(entity, data),
            side: THREE.DoubleSide
        });
        return new THREE.Mesh(geometry, material);
    }

    function drawEllipse(entity, data) {
        var color = getColor(entity, data);

        var xrad = Math.sqrt(Math.pow(entity.majorAxisEndPoint.x, 2) + Math.pow(entity.majorAxisEndPoint.y, 2));
        var yrad = xrad * entity.axisRatio;
        var rotation = Math.atan2(entity.majorAxisEndPoint.y, entity.majorAxisEndPoint.x);

        var curve = new THREE.EllipseCurve(
            entity.center.x, entity.center.y,
            xrad, yrad,
            entity.startAngle, entity.endAngle,
            false, // Always counterclockwise
            rotation
        );

        var points = curve.getPoints(50);
        var geometry = new THREE.BufferGeometry().setFromPoints(points);
        var material = new THREE.LineBasicMaterial({ linewidth: 1, color: color });

        // Create the final object to add to the scene
        var ellipse = new THREE.Line(geometry, material);
        return ellipse;
    }


    function drawSpline(entity, data) {
        var color = getColor(entity, data);

        var points = getBSplinePolyline(entity.controlPoints, entity.degreeOfSplineCurve, entity.knotValues, 100);

        var geometry = new THREE.BufferGeometry().setFromPoints(points);
        var material = new THREE.LineBasicMaterial({ linewidth: 1, color: color });
        var splineObject = new THREE.Line(geometry, material);

        return splineObject;
    }

    /**
 * Interpolate a b-spline. The algorithm examins the knot vector
 * to create segments for interpolation. The parameterisation value
 * is re-normalised back to [0,1] as that is what the lib expects (
 * and t i de-normalised in the b-spline library)
 *
 * @param controlPoints the control points
 * @param degree the b-spline degree
 * @param knots the knot vector
 * @returns the polyline
 */
    function getBSplinePolyline(controlPoints, degree, knots, interpolationsPerSplineSegment, weights) {
        const polyline = []
        const controlPointsForLib = controlPoints.map(function (p) {
            return [p.x, p.y]
        })

        const segmentTs = [knots[degree]]
        const domain = [knots[degree], knots[knots.length - 1 - degree]]

        for (let k = degree + 1; k < knots.length - degree; ++k) {
            if (segmentTs[segmentTs.length - 1] !== knots[k]) {
                segmentTs.push(knots[k])
            }
        }

        interpolationsPerSplineSegment = interpolationsPerSplineSegment || 25
        for (let i = 1; i < segmentTs.length; ++i) {
            const uMin = segmentTs[i - 1]
            const uMax = segmentTs[i]
            for (let k = 0; k <= interpolationsPerSplineSegment; ++k) {
                const u = k / interpolationsPerSplineSegment * (uMax - uMin) + uMin
                // Clamp t to 0, 1 to handle numerical precision issues
                let t = (u - domain[0]) / (domain[1] - domain[0])
                t = Math.max(t, 0)
                t = Math.min(t, 1)
                const p = bSpline(t, degree, controlPointsForLib, knots, weights)
                polyline.push(new THREE.Vector2(p[0], p[1]));
            }
        }
        return polyline
    }

    function drawLine(entity, data) {
        let points = [];
        let color = getColor(entity, data);
        var material, lineType, vertex, startPoint, endPoint, bulgeGeometry,
            bulge, i, line;

        if (!entity.vertices) return console.log('entity missing vertices.');

        // create geometry
        for (i = 0; i < entity.vertices.length; i++) {

            if (entity.vertices[i].bulge) {
                bulge = entity.vertices[i].bulge;
                startPoint = entity.vertices[i];
                endPoint = i + 1 < entity.vertices.length ? entity.vertices[i + 1] : points[0];

                let bulgePoints = getBulgeCurvePoints(startPoint, endPoint, bulge);

                points.push.apply(points, bulgePoints);
            } else {
                vertex = entity.vertices[i];
                // TeamSync fork: preserve Z so 3D LINE/POLYLINE wireframes
                // (the common 3D representation in legacy DWGs) render in
                // space. Upstream hardcoded Z=0 here, flattening everything.
                points.push(new THREE.Vector3(vertex.x, vertex.y, vertex.z || 0));
            }

        }
        if (entity.shape) points.push(points[0]);


        // set material
        if (entity.lineType) {
            lineType = data.tables.lineType.lineTypes[entity.lineType];
        }

        if (lineType && lineType.pattern && lineType.pattern.length !== 0) {
            material = new THREE.LineDashedMaterial({ color: color, gapSize: 4, dashSize: 4 });
        } else {
            material = new THREE.LineBasicMaterial({ linewidth: 1, color: color });
        }

        var geometry = new BufferGeometry().setFromPoints(points);

        line = new THREE.Line(geometry, material);
        return line;
    }

    function drawArc(entity, data) {
        var startAngle, endAngle;
        if (entity.type === 'CIRCLE') {
            startAngle = entity.startAngle || 0;
            endAngle = startAngle + 2 * Math.PI;
        } else {
            startAngle = entity.startAngle;
            endAngle = entity.endAngle;
        }

        var curve = new THREE.ArcCurve(
            0, 0,
            entity.radius,
            startAngle,
            endAngle);

        var points = curve.getPoints(32);
        var geometry = new THREE.BufferGeometry().setFromPoints(points);

        var material = new THREE.LineBasicMaterial({ color: getColor(entity, data) });

        var arc = new THREE.Line(geometry, material);
        arc.position.x = entity.center.x;
        arc.position.y = entity.center.y;
        arc.position.z = entity.center.z;

        return arc;
    }

    function addTriangleFacingCamera(verts, p0, p1, p2) {
        // Calculate which direction the points are facing (clockwise or counter-clockwise)
        var vector1 = new Vector3();
        var vector2 = new Vector3();
        vector1.subVectors(p1, p0);
        vector2.subVectors(p2, p0);
        vector1.cross(vector2);

        var v0 = new Vector3(p0.x, p0.y, p0.z);
        var v1 = new Vector3(p1.x, p1.y, p1.z);
        var v2 = new Vector3(p2.x, p2.y, p2.z);

        // If z < 0 then we must draw these in reverse order
        if (vector1.z < 0) {
            verts.push(v2, v1, v0);
        } else {
            verts.push(v0, v1, v2);
        }
    }

    function drawSolid(entity, data) {
        var material, verts,
            geometry = new THREE.BufferGeometry();

        var points = entity.points;
        // verts = geometry.vertices;
        verts = [];
        addTriangleFacingCamera(verts, points[0], points[1], points[2]);
        addTriangleFacingCamera(verts, points[1], points[2], points[3]);

        material = new THREE.MeshBasicMaterial({ color: getColor(entity, data) });
        geometry.setFromPoints(verts);

        return new THREE.Mesh(geometry, material);
    }


    function drawPoint(entity, data) {
        var geometry, material, point;

        geometry = new THREE.BufferGeometry();

        geometry.setAttribute('position', new Float32BufferAttribute([entity.position.x, entity.position.y, entity.position.z], 3));

        var color = getColor(entity, data);

        material = new THREE.PointsMaterial({ size: 0.1, color: new Color(color) });
        point = new THREE.Points(geometry, material);
        scene.add(point);
    }

    function drawDimension(entity, data) {
        var block = data.blocks[entity.block];

        if (!block || !block.entities) return null;

        var group = new THREE.Object3D();
        // if(entity.anchorPoint) {
        //     group.position.x = entity.anchorPoint.x;
        //     group.position.y = entity.anchorPoint.y;
        //     group.position.z = entity.anchorPoint.z;
        // }

        for (var i = 0; i < block.entities.length; i++) {
            var childEntity = drawEntity(block.entities[i], data, group);
            if (childEntity) group.add(childEntity);
        }

        return group;
    }

    function drawBlock(entity, data) {
        var block = data.blocks[entity.name];

        if (!block.entities) return null;

        var group = new THREE.Object3D()

        if (entity.xScale) group.scale.x = entity.xScale;
        if (entity.yScale) group.scale.y = entity.yScale;

        if (entity.rotation) {
            group.rotation.z = entity.rotation * Math.PI / 180;
        }

        if (entity.position) {
            group.position.x = entity.position.x;
            group.position.y = entity.position.y;
            group.position.z = entity.position.z;
        }

        for (var i = 0; i < block.entities.length; i++) {
            var childEntity = drawEntity(block.entities[i], data, group);
            if (childEntity) group.add(childEntity);
        }

        return group;
    }

    function getColor(entity, data) {
        var color = 0x000000; //default
        if (entity.color) color = entity.color;
        else if (data.tables && data.tables.layer && data.tables.layer.layers[entity.layer])
            color = data.tables.layer.layers[entity.layer].color;

        if (color == null || color === 0xffffff) {
            color = 0x000000;
        }
        return color;
    }

    function createLineTypeShaders(data) {
        var ltype, type;
        if (!data.tables || !data.tables.lineType) return;
        var ltypes = data.tables.lineType.lineTypes;

        for (type in ltypes) {
            ltype = ltypes[type];
            if (!ltype.pattern) continue;
            ltype.material = createDashedLineShader(ltype.pattern);
        }
    }

    function createDashedLineShader(pattern) {
        var i,
            dashedLineShader = {},
            totalLength = 0.0;

        for (i = 0; i < pattern.length; i++) {
            totalLength += Math.abs(pattern[i]);
        }

        dashedLineShader.uniforms = THREE.UniformsUtils.merge([

            THREE.UniformsLib['common'],
            THREE.UniformsLib['fog'],

            {
                'pattern': { type: 'fv1', value: pattern },
                'patternLength': { type: 'f', value: totalLength }
            }

        ]);

        dashedLineShader.vertexShader = [
            'attribute float lineDistance;',

            'varying float vLineDistance;',

            THREE.ShaderChunk['color_pars_vertex'],

            'void main() {',

            THREE.ShaderChunk['color_vertex'],

            'vLineDistance = lineDistance;',

            'gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',

            '}'
        ].join('\n');

        dashedLineShader.fragmentShader = [
            'uniform vec3 diffuse;',
            'uniform float opacity;',

            'uniform float pattern[' + pattern.length + '];',
            'uniform float patternLength;',

            'varying float vLineDistance;',

            THREE.ShaderChunk['color_pars_fragment'],
            THREE.ShaderChunk['fog_pars_fragment'],

            'void main() {',

            'float pos = mod(vLineDistance, patternLength);',

            'for ( int i = 0; i < ' + pattern.length + '; i++ ) {',
            'pos = pos - abs(pattern[i]);',
            'if( pos < 0.0 ) {',
            'if( pattern[i] > 0.0 ) {',
            'gl_FragColor = vec4(1.0, 0.0, 0.0, opacity );',
            'break;',
            '}',
            'discard;',
            '}',

            '}',

            THREE.ShaderChunk['color_fragment'],
            THREE.ShaderChunk['fog_fragment'],

            '}'
        ].join('\n');

        return dashedLineShader;
    }

    function findExtents(scene) {
        for (var child of scene.children) {
            var minX, maxX, minY, maxY;
            if (child.position) {
                minX = Math.min(child.position.x, minX);
                minY = Math.min(child.position.y, minY);
                maxX = Math.max(child.position.x, maxX);
                maxY = Math.max(child.position.y, maxY);
            }
        }

        return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    }

}


// Show/Hide helpers from https://plainjs.com/javascript/effects/hide-or-show-an-element-42/
// get the default display style of an element
function defaultDisplay(tag) {
    var iframe = document.createElement('iframe');
    iframe.setAttribute('frameborder', 0);
    iframe.setAttribute('width', 0);
    iframe.setAttribute('height', 0);
    document.documentElement.appendChild(iframe);

    var doc = (iframe.contentWindow || iframe.contentDocument).document;

    // IE support
    doc.write();
    doc.close();

    var testEl = doc.createElement(tag);
    doc.documentElement.appendChild(testEl);
    var display = (window.getComputedStyle ? getComputedStyle(testEl, null) : testEl.currentStyle).display
    iframe.parentNode.removeChild(iframe);
    return display;
}

// actual show/hide function used by show() and hide() below
function showHide(el, show) {
    var value = el.getAttribute('data-olddisplay'),
        display = el.style.display,
        computedDisplay = (window.getComputedStyle ? getComputedStyle(el, null) : el.currentStyle).display;

    if (show) {
        if (!value && display === 'none') el.style.display = '';
        if (el.style.display === '' && (computedDisplay === 'none')) value = value || defaultDisplay(el.nodeName);
    } else {
        if (display && display !== 'none' || !(computedDisplay == 'none'))
            el.setAttribute('data-olddisplay', (computedDisplay == 'none') ? display : computedDisplay);
    }
    if (!show || el.style.display === 'none' || el.style.display === '')
        el.style.display = show ? value || '' : 'none';
}

// helper functions
function show(el) { showHide(el, true); }
function hide(el) { showHide(el); }



