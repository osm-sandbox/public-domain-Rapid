import { select as d3_select } from 'd3-selection';
import { Extent, Tiler, geoMetersToLat, geoMetersToLon, geomRotatePoints, geomPointInPolygon, vecLength } from '@rapid-sdk/math';
import { utilQsString } from '@rapid-sdk/util';
import RBush from 'rbush';

import { AbstractSystem } from '../core/AbstractSystem.js';
import { uiIcon } from '../ui/icon.js';
import { utilFetchResponse } from '../util/index.js';

const TILEZOOM = 16.5;


/**
 * `StreetsideService`
 * This service loads streetside photos and coverage information from
 * various Microsoft/VirtualEarth APIs.
 *
 * It also manages the embedded Pannellum panoramic photo viewer.
 * @see https://pannellum.org/documentation/api
 *
 * Events available:
 *   `imageChanged`   - fired when a new image is visible in the viewer
 *   `bearingChanged` - fired when the viewer has been panned, receives the bearing value in degrees.
 *   `fovChanged`     - fired when the viewer has been zoomed, receives the fov value in degrees.
 *   'loadedData'
 */
export class StreetsideService extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'streetside';
    this.autoStart = false;

    this._loadPromise = null;
    this._startPromise = null;

    this._hires = false;
    this._resolution = 512;    // higher numbers are slower - 512, 1024, 2048, 4096
    this._currScene = 0;
    this._cache = {};
    this._viewer = null;
    this._nextSequenceID = 0;
    this._waitingForPhotoID = null;

    this._sceneOptions = {
      type: 'cubemap',
      cubeMap: [],
      showFullscreenCtrl: false,
      autoLoad: true,
      compass: true,
      friction: 1,    // don't keep moving after interaction stops
      minHfov: 10,    // zoom in degrees:  20, 10, 5
      maxHfov: 90,    // zoom out degrees
      hfov: 45,       // default field of view degrees
      yaw: 0          // default compass angle
    };

    this._keydown = this._keydown.bind(this);

    // Ensure methods used as callbacks always have `this` bound correctly.
    // (This is also necessary when using `d3-selection.call`)
    this._setupCanvas = this._setupCanvas.bind(this);

    this._tiler = new Tiler().zoomRange(TILEZOOM).skipNullIsland(true);
    this._lastv = null;
  }


  /**
   * _keydown
   * Handler for keydown events on the window, but only if the photo viewer is visible.
   * @param  `e`  A DOM KeyboardEvent
   */
  _keydown(e) {
    // Ignore keypresses unless we actually have a streetside photo showing
    const photos = this.context.systems.photos;
    if (!this.viewerShowing || photos.currPhotoLayerID !== 'streetside') return;

    // Only allow key navigation if the user doesn't have something
    // more important focused - like a input, textarea, menu, etc.
    const activeElement = document.activeElement?.tagName ?? 'BODY';
    if (activeElement !== 'BODY') return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      this._step(-1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      this._step(1);
    }
  }


  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    return this.resetAsync();
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    if (this._startPromise) return this._startPromise;

    const context = this.context;
    const eventManager = context.systems.gfx.events;
    const ui = context.systems.ui;

    // create ms-wrapper, a photo wrapper class
    let $wrapper = context.container().select('.photoviewer .middle-middle')
      .selectAll('.ms-wrapper')
      .data([0]);

    const $$wrapper = $wrapper.enter()
      .append('div')
      .attr('class', 'photo-wrapper ms-wrapper')
      .classed('hide', true);

    $$wrapper
      .append('div')
      .attr('id', 'rapideditor-viewer-streetside');

    // add .photo-footer
    const $$footer = $$wrapper
      .append('div')
      .attr('class', 'photo-footer');

    $$footer
      .append('div')
      .attr('class', 'photo-options');

    $$footer
      .append('div')
      .attr('class', 'photo-attribution');

    // add .photo-controls
    const $$controls = $$wrapper
      .append('div')
      .attr('class', 'photo-controls-wrap')
      .append('div')
      .attr('class', 'photo-controls');

    $$controls
      .append('button')
      .on('click.back', () => this._step(-1))
      .call(uiIcon('#fas-backward-step'));

    $$controls
      .append('button')
      .on('click.forward', () => this._step(1))
      .call(uiIcon('#fas-forward-step'));


    // create working canvas for stitching together images
    $wrapper = $wrapper.merge($$wrapper)
      .call(this._setupCanvas);

    // Register viewer resize handler
    ui.PhotoViewer.on('resize', () => {
      if (this._viewer) this._viewer.resize();
    });

    eventManager.on('keydown', this._keydown);

    return this._startPromise = this._loadAssetsAsync()
      .then(() => this._started = true)
      .catch(err => {
        if (err instanceof Error) console.error(err);   // eslint-disable-line no-console
        this._startPromise = null;
      });
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    if (this._cache.inflight) {
      for (const inflight of this._cache.inflight.values()) {
        inflight.controller.abort();
      }
    }

    this._cache = {
      rbush:     new RBush(),
      inflight:  new Map(),   // Map(tileID -> {Promise, AbortController})
      loaded:    new Set(),   // Set(tileID)
      bubbles:   new Map(),   // Map(bubbleID -> bubble data)
      sequences: new Map(),   // Map(sequenceID -> sequence data)
      unattachedBubbles:   new Set(),  // Set(bubbleID)
      bubbleHasSequences:  new Map(),  // Map(bubbleID -> Array(sequenceID))
      metadataPromise:  null
    };

    this.lastv = null;

    return Promise.resolve();
  }


  /**
   * getImages
   * Get already loaded image data that appears in the current map view
   * @return  {Array}  Array of image data
   */
  getImages() {
    const extent = this.context.viewport.visibleExtent();
    return this._cache.rbush.search(extent.bbox()).map(d => d.data);
  }


  /**
   * getSequences
   * Get already loaded sequence data that appears in the current map view
   * @return  {Array}  Array of sequence data
   */
  getSequences() {
    const cache = this._cache;
    const extent = this.context.viewport.visibleExtent();
    const results = new Map();  // Map(sequenceID -> sequence)

    // Gather sequences for the bubbles in viewport
    for (const box of cache.rbush.search(extent.bbox())) {
      const bubbleID = box.data.id;
      const sequenceIDs = cache.bubbleHasSequences.get(bubbleID) ?? [];
      for (const sequenceID of sequenceIDs) {
        if (!results.has(sequenceID)) {
          results.set(sequenceID, cache.sequences.get(sequenceID));
        }
      }
    }
    return [...results.values()];
  }


  /**
   * loadTiles
   * Schedule any data requests needed to cover the current map view
   */
  loadTiles() {
    const viewport = this.context.viewport;
    if (this._lastv === viewport.v) return;  // exit early if the view is unchanged
    this._lastv = viewport.v;

    // Determine the tiles needed to cover the view..
    // By default: request 2 nearby tiles so we can connect sequences.
    const MARGIN = 2;
    const tiles = this._tiler.zoomRange(TILEZOOM).margin(MARGIN).getTiles(viewport).tiles;

    // Abort inflight requests that are no longer needed..
    for (const [tileID, inflight] of this._cache.inflight) {
      const needed = tiles.find(tile => tile.id === tileID);
      if (!needed) {
        inflight.controller.abort();
      }
    }

    // Issue new requests..
    for (const tile of tiles) {
      const tileID = tile.id;
      if (this._cache.loaded.has(tileID) || this._cache.inflight.has(tileID)) continue;

      // Promise.all([this._fetchMetadataAsync(tile), this._loadTileAsync(tile)])
      this._loadTileAsync(tile);
    }
  }


  get viewerShowing() {
    return this._showing;
  }


  /**
   * showViewer
   * Shows the photo viewer, and hides all other photo viewers
   */
  showViewer() {
    const $viewer = this.context.container().select('.photoviewer')
      .classed('hide', false);

    const isHidden = $viewer.selectAll('.photo-wrapper.ms-wrapper.hide').size();

    if (isHidden) {
      $viewer
        .selectAll('.photo-wrapper:not(.ms-wrapper)')
        .classed('hide', true);

      this._showing = true;

      $viewer
        .selectAll('.photo-wrapper.ms-wrapper')
        .classed('hide', false);
    }
  }


  /**
   * hideViewer
   * Hides the photo viewer and clears the currently selected image
   */
  hideViewer() {
    const context = this.context;
    context.systems.photos.selectPhoto(null);

    const $viewer = context.container().select('.photoviewer');
    $viewer
      .classed('hide', true)
      .selectAll('.photo-wrapper')
      .classed('hide', true);

    this._showing = false;

    this.emit('imageChanged');
  }


  /**
   * selectImageAsync
   * Note:  most code should call `PhotoSystem.selectPhoto(layerID, photoID)` instead.
   * That will manage the state of what the user clicked on, and then call this function.
   * @param  {string} imageID - the id of the image to select
   * @return {Promise} Promise that resolves to the image after it has been selected
   */
  selectImageAsync(bubbleID) {
    if (!bubbleID) {
      this._updatePhotoFooter(null);  // reset
      return Promise.resolve();  // do nothing
    }

    let bubble = this._cache.bubbles.get(bubbleID);

    const context = this.context;

    const $wrapper = context.container().select('.photoviewer .ms-wrapper');
    $wrapper.selectAll('.pnlm-load-box')   // display "loading.."
      .style('display', 'block')
      .style('transform', 'translate(-50%, -50%)');

    // It's possible we could be trying to show a photo that hasn't been fetched yet
    // (e.g. if we are starting up with a photoID specified in the url hash)
    if (bubbleID && !bubble) {
      this._waitingForPhotoID = bubbleID;
    }
    if (!bubble) return Promise.resolve();

    this._sceneOptions.northOffset = bubble.ca;

    this._updatePhotoFooter(bubbleID);

    const streetsideImagesApi = 'https://ecn.t0.tiles.virtualearth.net/tiles/';

    const asNumber = parseInt(bubbleID, 10);
    let bubbleIdQuadKey = asNumber.toString(4);
    const paddingNeeded = 16 - bubbleIdQuadKey.length;
    for (let i = 0; i < paddingNeeded; i++) {
      bubbleIdQuadKey = '0' + bubbleIdQuadKey;
    }
    const imgUrlPrefix = streetsideImagesApi + 'hs' + bubbleIdQuadKey;
    // const imgUrlSuffix = '.jpg?g=6338&n=z';
    const imgUrlSuffix = '?g=13305&n=z';

    // Cubemap face code order matters here: front=01, right=02, back=03, left=10, up=11, down=12
    const faceKeys = ['01','02','03','10','11','12'];

    // Map images to cube faces
    const quadKeys = this._getQuadKeys();
    const faces = faceKeys.map(faceKey => {
      return quadKeys.map(quadKey => {
        const xy = this._qkToXY(quadKey);
        return {
          face: faceKey,
          url: imgUrlPrefix + faceKey + quadKey + imgUrlSuffix,
          x: xy[0],
          y: xy[1]
        };
      });
    });

    return this._loadFacesAsync(faces)
      .then(() => {
        if (!this._viewer) {
          this._initViewer();
        } else {
          // make a new scene
          this._currScene++;
          let sceneID = this._currScene.toString();
          this._viewer
            .addScene(sceneID, this._sceneOptions)
            .loadScene(sceneID);

          // remove previous scene
          if (this._currScene > 2) {
            sceneID = (this._currScene - 1).toString();
            this._viewer
              .removeScene(sceneID);
          }
        }

        return bubble; // pass the image to anything that chains off this Promise
      });
  }


  /**
   * _updatePhotoFooter
   * Update the photo attribution section of the image viewer
   * @param  {string} bubbleID - the new bubbleID
   */
  _updatePhotoFooter(bubbleID) {
    const context = this.context;
    const l10n = context.systems.l10n;
    const photos = context.systems.photos;
    const $wrapper = context.container().select('.photoviewer .ms-wrapper');

    // Options Section
    const $options = $wrapper.selectAll('.photo-options');

    // .hires checkbox
    let $label = $options.selectAll('.hires')
      .data([0]);

    // enter
    const $$label = $label.enter()
      .append('label')
      .attr('for', 'ms-hires-input')
      .attr('class', 'hires');

    $$label
      .append('input')
      .attr('type', 'checkbox')
      .attr('id', 'ms-hires-input')
      .on('click', e => {
        e.stopPropagation();

        this._hires = !this._hires;
        this._resolution = this._hires ? 1024 : 512;
        $wrapper.call(this._setupCanvas);

        const viewstate = {
          yaw: this._viewer.getYaw(),
          pitch: this._viewer.getPitch(),
          hfov: this._viewer.getHfov()
        };

        this._sceneOptions = Object.assign(this._sceneOptions, viewstate);
        this.selectImageAsync(photos.currPhotoID);  // reselect
      });

    $$label
      .append('span');

    // update
    $label = $label.merge($$label);
    $label.selectAll('#ms-hires-input')
      .property('checked', this._hires);

    $label.selectAll('span')
      .text(l10n.t('photos.hires'));


    // Attribution Section
    const $attribution = $wrapper.selectAll('.photo-attribution').html('&nbsp;');  // clear DOM content

    const image = this._cache.bubbles.get(bubbleID);
    if (!image) return;

    if (image.captured_by) {
      $attribution
        .append('span')
        .attr('class', 'captured_by')
        .text(image.captured_by);

      $attribution
        .append('span')
        .text('|');
    }

    if (image.captured_at) {
      $attribution
        .append('span')
        .attr('class', 'captured_at')
        .text(_localeDateString(image.captured_at));

      $attribution
        .append('span')
        .text('|');
    }

    $attribution
      .append('a')
      .attr('class', 'image-link')
      .attr('target', '_blank')
      .attr('href', `https://www.bing.com/maps?cp=${image.loc[1]}~${image.loc[0]}&lvl=17&dir=${image.ca}&style=x&v=2&sV=1`)
      .text('bing.com');


    function _localeDateString(s) {
      if (!s) return null;
      const options = { day: 'numeric', month: 'short', year: 'numeric' };
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;

      const localeCode = context.systems.l10n.localeCode();
      return d.toLocaleDateString(localeCode, options);
    }
  }


  /**
   * _loadAssetsAsync
   * Load the Pannellum JS and CSS files into the document head
   * @return {Promise} Promise resolved when both files have been loaded
   */
  _loadAssetsAsync() {
    if (this._loadPromise) return this._loadPromise;

    return this._loadPromise = new Promise((resolve, reject) => {
      const assets = this.context.systems.assets;

      let count = 0;
      const loaded = () => {
        if (++count === 2) resolve();
      };

      const $head = d3_select('head');

      $head.selectAll('#rapideditor-pannellum-css')
        .data([0])
        .enter()
        .append('link')
        .attr('id', 'rapideditor-pannellum-css')
        .attr('rel', 'stylesheet')
        .attr('crossorigin', 'anonymous')
        .attr('href', assets.getAssetURL('pannellum_css'))
        .on('load', loaded)
        .on('error', reject);

      $head.selectAll('#rapideditor-pannellum-js')
        .data([0])
        .enter()
        .append('script')
        .attr('id', 'rapideditor-pannellum-js')
        .attr('crossorigin', 'anonymous')
        .attr('src', assets.getAssetURL('pannellum_js'))
        .on('load', loaded)
        .on('error', reject);
    });
  }


  /**
   * _initViewer
   * Initializes the Pannellum viewer
   */
  _initViewer() {
    if (!window.pannellum) throw new Error('pannellum not loaded');
    if (this._viewer) return;  // already initted

    this._currScene++;
    const sceneID = this._currScene.toString();
    const options = {
      'default': { firstScene: sceneID },
      scenes: {}
    };
    options.scenes[sceneID] = this._sceneOptions;


    const imageChanged = () => {
      this.emit('imageChanged');
    };

    const fovChanged = () => {
      this.emit('fovChanged', this._viewer.getHfov());
    };

    this._viewer = window.pannellum.viewer('rapideditor-viewer-streetside', options);
    this._viewer.on('load', imageChanged);
    this._viewer.on('zoomchange', fovChanged);

    this.context.container().select('#rapideditor-viewer-streetside')
      .on('pointerdown.streetside', () => {
        d3_select(window)
          .on('pointermove.streetside', () => {
            this.emit('bearingChanged', this._viewer.getYaw());
          });
      })
      .on('pointerup.streetside pointercancel.streetside', () => {
        d3_select(window)
          .on('pointermove.streetside', null);
      });
  }


  /**
   * _step
   * Step to the next bubble in the sequence
   * @param  stepBy  1 to step forward, -1 to step backward
   */
  _step(stepBy) {
    const context = this.context;
    const photos = context.systems.photos;

    const currBubbleID = photos.currPhotoID;
    const selected = this._cache.bubbles.get(currBubbleID);
    if (!selected) return;

    let nextID = (stepBy === 1 ? selected.ne : selected.pr);
    const yaw = this._viewer.getYaw();
    this._sceneOptions.yaw = yaw;

    const ca = selected.ca + yaw;
    const origin = selected.loc;

    // construct a search trapezoid pointing out from current bubble
    const meters = 35;
    const p1 = [
      origin[0] + geoMetersToLon(meters / 5, origin[1]),
      origin[1]
    ];
    const p2 = [
      origin[0] + geoMetersToLon(meters / 2, origin[1]),
      origin[1] + geoMetersToLat(meters)
    ];
    const p3 = [
      origin[0] - geoMetersToLon(meters / 2, origin[1]),
      origin[1] + geoMetersToLat(meters)
    ];
    const p4 = [
      origin[0] - geoMetersToLon(meters / 5, origin[1]),
      origin[1]
    ];

    let poly = [p1, p2, p3, p4, p1];

    // rotate it to face forward/backward
    const angle = (stepBy === 1 ? ca : ca + 180) * (Math.PI / 180);
    poly = geomRotatePoints(poly, -angle, origin);

    const extent = new Extent();
    for (const point of poly) {
      extent.extendSelf(point);
    }

    // find nearest other bubble in the search polygon
    let minDist = Infinity;
    this._cache.rbush.search(extent.bbox())
      .forEach(d => {
        if (d.data.id === selected.id) return;
        if (!geomPointInPolygon(d.data.loc, poly)) return;

        let dist = vecLength(d.data.loc, selected.loc);
        const theta = selected.ca - d.data.ca;
        const minTheta = Math.min(Math.abs(theta), 360 - Math.abs(theta));
        if (minTheta > 20) {
          dist += 5;  // penalize distance if camera angles don't match
        }

        if (dist < minDist) {
          nextID = d.data.id;
          minDist = dist;
        }
      });

    const nextBubble = this._cache.bubbles.get(nextID);
    if (!nextBubble) return;

    photos.selectPhoto('streetside', nextBubble.id);
    this.emit('imageChanged');
  }


  /**
   * _localeDateString
   */
  _localeDateString(s) {
    if (!s) return null;
    const options = { day: 'numeric', month: 'short', year: 'numeric' };
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;

    const localeCode = this.context.systems.l10n.localeCode();
    return d.toLocaleString(localeCode, options);
  }


  /**
   * _loadedBubbleData
   * Processes the results of the tile data fetch.
   * @param  {Array}  results
   */
  _loadedBubbleData(results) {
    // const metadata = results[0];
    // this._cache.loaded.add(results[1].tile.id);
    // const bubbles = results[1].data;
    const cache = this._cache;

    cache.loaded.add(results.tile.id);
    const bubbles = results.data;
    if (!bubbles) return;
    if (bubbles.error) throw new Error(bubbles.error);

    // [].shift() removes the first element, some statistics info, not a bubble point
    bubbles.shift();

    let selectBubbleID = null;
    const boxes = bubbles.map(bubble => {
      const bubbleNum = bubble.id;
      const bubbleID = bubbleNum.toString();
      if (this._waitingForPhotoID === bubbleID) {
        selectBubbleID = bubbleID;
        this._waitingForPhotoID = null;
      }

      if (cache.bubbles.has(bubbleID)) return null;  // skip duplicates

      const loc = [bubble.lo, bubble.la];
      const bubbleData = {
        type:         'photo',
        service:      'streetside',
        loc:          loc,
        id:           bubbleID,
        ca:           bubble.he,
        captured_at:  bubble.cd,
        captured_by:  'microsoft',
        pr:           bubble.pr?.toString(),  // previous
        ne:           bubble.ne?.toString(),  // next
        isPano:       true
      };

      cache.bubbles.set(bubbleID, bubbleData);
      cache.unattachedBubbles.add(bubbleID);

      return {
        minX: loc[0], minY: loc[1], maxX: loc[0], maxY: loc[1], data: bubbleData
      };

    }).filter(Boolean);

    this._cache.rbush.load(boxes);
    this._connectSequences();

    if (selectBubbleID) {
      const photos = this.context.systems.photos;
      photos.selectPhoto();                              // deselect
      photos.selectPhoto('streetside', selectBubbleID);  // reselect
    }

    const gfx = this.context.systems.gfx;
    gfx.deferredRedraw();
    this.emit('loadedData');
  }


  /**
   * _connectSequences
   * Call this sometimes to connect unattached bubbles into sequences.
   * Note that this algorithm has changed, as we seem to get different data.
   * The API we are using is undocumented :(
   */
  _connectSequences() {
    const cache = this._cache;
    const touchedSequenceIDs = new Set();  // sequences that we touched will need recalculation

    // bubbles that haven't been added to a sequence yet.
    // note: sort numerically to minimize the chance that we'll start assembling mid-sequence.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const toAttach = Array.from(cache.unattachedBubbles).sort(collator.compare);

    const _updateCaches = (sequenceID, bubbleID) => {
      touchedSequenceIDs.add(sequenceID);
      cache.unattachedBubbles.delete(bubbleID);

      let seqs = cache.bubbleHasSequences.get(bubbleID);
      if (!seqs) {
        seqs = [];
        cache.bubbleHasSequences.set(bubbleID, seqs);
      }
      seqs.push(sequenceID);
    };


    for (const currBubbleID of toAttach) {
      const isUnattached = cache.unattachedBubbles.has(currBubbleID);
      const currBubble = cache.bubbles.get(currBubbleID);
      if (!currBubble || !isUnattached) continue;   // done already

      // Look at adjacent bubbles
      const nextBubbleID = currBubble.ne;
      const nextBubble = nextBubbleID && cache.bubbles.get(nextBubbleID);
      const prevBubbleID = currBubble.pr;
      const prevBubble = prevBubbleID && cache.bubbles.get(prevBubbleID);

      // Try to link next bubble back to current bubble.
      // Prefer a sequence where next.pr === currentBubbleID
      // But accept any sequence we can make, they don't always link in both directions.
      if (nextBubbleID && nextBubble) {
        let sequenceID, sequence;
        const trySequenceIDs = (nextBubble && cache.bubbleHasSequences.get(nextBubbleID)) || [];
        for (sequenceID of trySequenceIDs) {
          sequence = cache.sequences.get(sequenceID);
          const firstID = sequence.bubbleIDs.at(0);
          const lastID = sequence.bubbleIDs.at(-1);
          if (nextBubbleID === lastID) {
            sequence.bubbleIDs.push(currBubbleID);   // add current bubble to end of sequence
            _updateCaches(sequenceID, currBubbleID);
            break;
          } else if (nextBubbleID === firstID) {
            sequence.bubbleIDs.unshift(currBubbleID);  // add current bubble to beginning of sequence
            _updateCaches(sequenceID, currBubbleID);
            break;
          }
        }
      }

      // Try to link previous bubble forward to current bubble.
      if (prevBubbleID && prevBubble) {
        let sequenceID, sequence;
        const trySequenceIDs = (prevBubble && cache.bubbleHasSequences.get(prevBubbleID)) || [];
        for (sequenceID of trySequenceIDs) {
          sequence = cache.sequences.get(sequenceID);
          const firstID = sequence.bubbleIDs.at(0);
          const lastID = sequence.bubbleIDs.at(-1);
          if (prevBubbleID === lastID) {
            sequence.bubbleIDs.push(currBubbleID);   // add current bubble to end of sequence
            _updateCaches(sequenceID, currBubbleID);
            break;
          } else if (prevBubbleID === firstID) {
            sequence.bubbleIDs.unshift(currBubbleID);  // add current bubble to beginning of sequence
            _updateCaches(sequenceID, currBubbleID);
            break;
          }
        }
      }

      // If neither of those worked (current bubble still "unattached"),
      // Start a new sequence at the current bubble.
      if (cache.unattachedBubbles.has(currBubbleID)) {
        const sequenceNum = this._nextSequenceID++;
        const sequenceID = `s${sequenceNum}`;
        const sequence = {
          type:       'sequence',
          service:    'streetside',
          id:         sequenceID,
          v:          0,
          bubbleIDs:  [currBubbleID],
          isPano:     true
        };
        cache.sequences.set(sequenceID, sequence);
        _updateCaches(sequenceID, currBubbleID);

        // Include previous and next bubbles if we have them loaded
        if (prevBubbleID && prevBubble) {
          sequence.bubbleIDs.unshift(prevBubbleID);  // add previous to beginning
          _updateCaches(sequenceID, prevBubbleID);
        }
        if (nextBubbleID && nextBubble) {
          sequence.bubbleIDs.push(nextBubbleID);  // add next to end
          _updateCaches(sequenceID, nextBubbleID);
        }
      }
    }

    // Any sequences that we touched, bump version number and recompute the coordinate array
    for (const sequenceID of touchedSequenceIDs) {
      const sequence = cache.sequences.get(sequenceID);
      const bubbles = sequence.bubbleIDs.map(bubbleID => cache.bubbles.get(bubbleID));
      sequence.v++;
      sequence.captured_at = bubbles[0].captured_at;
      sequence.captured_by = bubbles[0].captured_by;
      sequence.coordinates = bubbles.map(bubble => bubble.loc);
    }
  }


  /**
   * _fetchMetadataAsync
   * https://learn.microsoft.com/en-us/bingmaps/rest-services/imagery/get-imagery-metadata
   */
  _fetchMetadataAsync(tile) {
    // only fetch it once
    if (this._cache.metadataPromise) return this._cache.metadataPromise;

    const [lon, lat] = tile.wgs84Extent.center();
    const metadataURLBase = 'https://dev.virtualearth.net/REST/v1/Imagery/MetaData/Streetside';
    const metadataKey = 'AoG8TaQvkPo6o8SlpRVmBs7WJwO_NDQklVRcAfpn7P8oiEMYWNY59XHSJU81sP1Y';
    const metadataURL = `${metadataURLBase}/${lat},${lon}?key=${metadataKey}`;

    this._cache.metadataPromise = fetch(metadataURL)
      .then(utilFetchResponse)
      .then(data => {
        if (!data) throw new Error('no data');
        return data;
      });
  }


  /**
   * _loadTileAsync
   * bubbles:   undocumented / unsupported API?
   * see Rapid#1305, iD#10100
   */
  _loadTileAsync(tile) {
    const inflight = this._cache.inflight.get(tile.id);
    if (inflight) return inflight.promise;

    const [w, s, e, n] = tile.wgs84Extent.rectangle();
    const MAXRESULTS = 2000;

    const bubbleURLBase = 'https://t.ssl.ak.tiles.virtualearth.net/tiles/cmd/StreetSideBubbleMetaData?';
    const bubbleKey = 'AuftgJsO0Xs8Ts4M1xZUQJQXJNsvmh3IV8DkNieCiy3tCwCUMq76-WpkrBtNAuEm';
    const bubbleURL = bubbleURLBase + utilQsString({ north: n, south: s, east: e, west: w, count: MAXRESULTS, key: bubbleKey });

    const controller = new AbortController();
    const promise = fetch(bubbleURL, { signal: controller.signal })
      .then(utilFetchResponse)
      .then(data => {
        this._loadedBubbleData({
          data: JSON.parse(data),  // Content-Type is 'text/plain' for some reason
          tile: tile
        });
      })
      .catch(err => {
        if (err.name === 'AbortError') return;  // ok
        if (err instanceof Error) console.error(err);   // eslint-disable-line no-console
      })
      .finally(() => {
        this._cache.inflight.delete(tile.id);
      });

    this._cache.inflight.set(tile.id, { promise: promise, controller: controller });

    return promise;
  }


  /**
   * _loadImageAsync
   */
  _loadImageAsync(imgInfo) {
    return new Promise(resolve => {
      const face = imgInfo.face;
      const canvas = document.getElementById(`rapideditor-canvas${face}`);
      const ctx = canvas.getContext('2d');

      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, imgInfo.x, imgInfo.y);
        resolve({ imgInfo: imgInfo, status: 'ok' });
      };
      img.onerror = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        resolve({ imgInfo: imgInfo, status: 'error' });
      };
      img.setAttribute('crossorigin', '');
      img.src = imgInfo.url;
    });
  }


  /**
   * _loadFaceAsync
   */
  _loadFaceAsync(imageGroup) {
    return Promise.all(imageGroup.map(d => this._loadImageAsync(d)))
      .then(data => {
        const face = data[0].imgInfo.face;
        const canvas = document.getElementById(`rapideditor-canvas${face}`);
        const which = { '01': 0, '02': 1, '03': 2, '10': 3, '11': 4, '12': 5 };
        this._sceneOptions.cubeMap[which[face]] = canvas.toDataURL('image/jpeg', 1.0);
        return { status: `face ${face} ok` };
      });
  }


  /**
   * _loadFacesAsync
   */
  _loadFacesAsync(faceGroup) {
    return Promise.all(faceGroup.map(d => this._loadFaceAsync(d)))
      .then(() => { return { status: 'this._loadFacesAsync done' }; });
  }


  /**
   * _setupCanvas
   * Called when setting up the viewer, creates 6 canvas elements to load image data into,
   * so that it can be stitched together into a photosphere.
   */
  _setupCanvas($selection) {
    $selection.selectAll('#rapideditor-stitcher-canvases')
      .remove();

    // Add the Streetside working canvases. These are used for 'stitching', or combining,
    // multiple images for each of the six faces, before passing to the Pannellum control as DataUrls
    $selection.selectAll('#rapideditor-stitcher-canvases')
      .data([0])
      .enter()
      .append('div')
      .attr('id', 'rapideditor-stitcher-canvases')
      .attr('display', 'none')
      .selectAll('canvas')
      .data(['canvas01', 'canvas02', 'canvas03', 'canvas10', 'canvas11', 'canvas12'])
      .enter()
      .append('canvas')
      .attr('id', d => `rapideditor-${d}`)
      .attr('width', this._resolution)
      .attr('height', this._resolution);
  }


  _qkToXY(qk) {
    let x = 0;
    let y = 0;
    let scale = 256;
    for (let i = qk.length; i > 0; i--) {
      const key = qk[i-1];
      x += (+(key === '1' || key === '3')) * scale;
      y += (+(key === '2' || key === '3')) * scale;
      scale *= 2;
    }
    return [x, y];
  }


  _getQuadKeys() {
    const dim = this._resolution / 256;
    let quadKeys;

    if (dim === 16) {
      quadKeys = [
        '0000','0001','0010','0011','0100','0101','0110','0111',  '1000','1001','1010','1011','1100','1101','1110','1111',
        '0002','0003','0012','0013','0102','0103','0112','0113',  '1002','1003','1012','1013','1102','1103','1112','1113',
        '0020','0021','0030','0031','0120','0121','0130','0131',  '1020','1021','1030','1031','1120','1121','1130','1131',
        '0022','0023','0032','0033','0122','0123','0132','0133',  '1022','1023','1032','1033','1122','1123','1132','1133',
        '0200','0201','0210','0211','0300','0301','0310','0311',  '1200','1201','1210','1211','1300','1301','1310','1311',
        '0202','0203','0212','0213','0302','0303','0312','0313',  '1202','1203','1212','1213','1302','1303','1312','1313',
        '0220','0221','0230','0231','0320','0321','0330','0331',  '1220','1221','1230','1231','1320','1321','1330','1331',
        '0222','0223','0232','0233','0322','0323','0332','0333',  '1222','1223','1232','1233','1322','1323','1332','1333',

        '2000','2001','2010','2011','2100','2101','2110','2111',  '3000','3001','3010','3011','3100','3101','3110','3111',
        '2002','2003','2012','2013','2102','2103','2112','2113',  '3002','3003','3012','3013','3102','3103','3112','3113',
        '2020','2021','2030','2031','2120','2121','2130','2131',  '3020','3021','3030','3031','3120','3121','3130','3131',
        '2022','2023','2032','2033','2122','2123','2132','2133',  '3022','3023','3032','3033','3122','3123','3132','3133',
        '2200','2201','2210','2211','2300','2301','2310','2311',  '3200','3201','3210','3211','3300','3301','3310','3311',
        '2202','2203','2212','2213','2302','2303','2312','2313',  '3202','3203','3212','3213','3302','3303','3312','3313',
        '2220','2221','2230','2231','2320','2321','2330','2331',  '3220','3221','3230','3231','3320','3321','3330','3331',
        '2222','2223','2232','2233','2322','2323','2332','2333',  '3222','3223','3232','3233','3322','3323','3332','3333'
      ];

    } else if (dim === 8) {
      quadKeys = [
        '000','001','010','011',  '100','101','110','111',
        '002','003','012','013',  '102','103','112','113',
        '020','021','030','031',  '120','121','130','131',
        '022','023','032','033',  '122','123','132','133',

        '200','201','210','211',  '300','301','310','311',
        '202','203','212','213',  '302','303','312','313',
        '220','221','230','231',  '320','321','330','331',
        '222','223','232','233',  '322','323','332','333'
      ];

    } else if (dim === 4) {
      quadKeys = [
        '00','01',  '10','11',
        '02','03',  '12','13',

        '20','21',  '30','31',
        '22','23',  '32','33'
      ];

    } else {  // dim === 2
      quadKeys = [
        '0', '1',
        '2', '3'
      ];
    }

    return quadKeys;
  }

}
