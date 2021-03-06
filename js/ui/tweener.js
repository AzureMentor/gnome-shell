// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { Clutter, GLib, Shell, St } = imports.gi;
const Signals = imports.signals;
const Tweener = imports.tweener.tweener;

// This is a wrapper around imports.tweener.tweener that adds a bit of
// Clutter integration. If the tweening target is a Clutter.Actor, then
// the tweenings will automatically be removed if the actor is destroyed.

// ActionScript Tweener methods that imports.tweener.tweener doesn't
// currently implement: getTweens, getVersion, registerTransition,
// setTimeScale, updateTime.

// imports.tweener.tweener methods that we don't re-export:
// pauseAllTweens, removeAllTweens, resumeAllTweens. (It would be hard
// to clean up properly after removeAllTweens, and also, any code that
// calls any of these is almost certainly wrong anyway, because they
// affect the entire application.)

// Called from Main.start
function init() {
    Tweener.setFrameTicker(new ClutterFrameTicker());
}


function addCaller(target, tweeningParameters) {
    _wrapTweening(target, tweeningParameters);
    Tweener.addCaller(target, tweeningParameters);
}

function addTween(target, tweeningParameters) {
    _wrapTweening(target, tweeningParameters);
    Tweener.addTween(target, tweeningParameters);
}

function _wrapTweening(target, tweeningParameters) {
    let state = _getTweenState(target);

    if (!state.destroyedId) {
        if (target instanceof Clutter.Actor) {
            state.actor = target;
            state.destroyedId = target.connect('destroy', _actorDestroyed);
        } else if (target.actor && target.actor instanceof Clutter.Actor) {
            state.actor = target.actor;
            state.destroyedId = target.actor.connect('destroy', () => _actorDestroyed(target));
        }
    }

    if (!St.Settings.get().enable_animations) {
        tweeningParameters['time'] = 0.000001;
        tweeningParameters['delay'] = 0.000001;
    }

    _addHandler(target, tweeningParameters, 'onComplete', _tweenCompleted);
}

function _getTweenState(target) {
    // If we were paranoid, we could keep a plist mapping targets to
    // states... but we're not that paranoid.
    if (!target.__ShellTweenerState)
        target.__ShellTweenerState = {};
    return target.__ShellTweenerState;
}

function _resetTweenState(target) {
    let state = target.__ShellTweenerState;

    if (state) {
        if (state.destroyedId)
            state.actor.disconnect(state.destroyedId);
    }

    target.__ShellTweenerState = {};
}

function _addHandler(target, params, name, handler) {
    if (params[name]) {
        let oldHandler = params[name];
        let oldScope = params[`${name}Scope`];
        let oldParams = params[`${name}Params`];
        let eventScope = oldScope ? oldScope : target;

        params[name] = () => {
            oldHandler.apply(eventScope, oldParams);
            handler(target);
        };
    } else {
        params[name] = () => handler(target);
    }
}

function _actorDestroyed(target) {
    _resetTweenState(target);
    Tweener.removeTweens(target);
}

function _tweenCompleted(target) {
    if (!isTweening(target))
        _resetTweenState(target);
}

function getTweenCount(scope) {
    return Tweener.getTweenCount(scope);
}

// imports.tweener.tweener doesn't provide this method (which exists
// in the ActionScript version) but it's easy to implement.
function isTweening(scope) {
    return Tweener.getTweenCount(scope) != 0;
}

function removeTweens(...args) {
    if (Tweener.removeTweens(args)) {
        let [scope] = args;
        // If we just removed the last active tween, clean up
        if (Tweener.getTweenCount(scope) == 0)
            _tweenCompleted(scope);
        return true;
    } else {
        return false;
    }
}

function pauseTweens(...args) {
    return Tweener.pauseTweens(...args);
}

function resumeTweens(...args) {
    return Tweener.resumeTweens(...args);
}


function registerSpecialProperty(...args) {
    Tweener.registerSpecialProperty(...args);
}

function registerSpecialPropertyModifier(name, modifyFunction, getFunction) {
    Tweener.registerSpecialPropertyModifier(name, modifyFunction, getFunction);
}

function registerSpecialPropertySplitter(name, splitFunction, parameters) {
    Tweener.registerSpecialPropertySplitter(name, splitFunction, parameters);
}


// The 'FrameTicker' object is an object used to feed new frames to
// Tweener so it can update values and redraw. The default frame
// ticker for Tweener just uses a simple timeout at a fixed frame rate
// and has no idea of "catching up" by dropping frames.
//
// We substitute it with custom frame ticker here that connects
// Tweener to a Clutter.TimeLine. Now, Clutter.Timeline itself isn't a
// whole lot more sophisticated than a simple timeout at a fixed frame
// rate, but at least it knows how to drop frames. (See
// HippoAnimationManager for a more sophisticated view of continuous
// time updates; even better is to pay attention to the vertical
// vblank and sync to that when possible.)
//
var ClutterFrameTicker = class {
    constructor() {
        // We don't have a finite duration; tweener will tell us to stop
        // when we need to stop, so use 1000 seconds as "infinity", and
        // set the timeline to loop. Doing this means we have to track
        // time ourselves, since clutter timeline's time will cycle
        // instead of strictly increase.
        this._timeline = new Clutter.Timeline({ duration: 1000 * 1000 });
        this._timeline.set_loop(true);
        this._startTime = -1;
        this._currentTime = -1;

        this._timeline.connect('new-frame', (timeline, frame) => {
            this._onNewFrame(frame);
        });

        let perfLog = Shell.PerfLog.get_default();
        perfLog.define_event("tweener.framePrepareStart",
                             "Start of a new animation frame",
                             "");
        perfLog.define_event("tweener.framePrepareDone",
                             "Finished preparing frame",
                             "");
    }

    get FRAME_RATE() {
        return 60;
    }

    _onNewFrame(frame) {
        // If there is a lot of setup to start the animation, then
        // first frame number we get from clutter might be a long ways
        // into the animation (or the animation might even be done).
        // That looks bad, so we always start at the first frame of the
        // animation then only do frame dropping from there.
        if (this._startTime < 0)
            this._startTime = GLib.get_monotonic_time() / 1000.0;

        // currentTime is in milliseconds
        let perfLog = Shell.PerfLog.get_default();
        this._currentTime = GLib.get_monotonic_time() / 1000.0 - this._startTime;
        perfLog.event("tweener.framePrepareStart");
        this.emit('prepare-frame');
        perfLog.event("tweener.framePrepareDone");
    }

    getTime() {
        return this._currentTime;
    }

    start() {
        if (St.get_slow_down_factor() > 0)
            Tweener.setTimeScale(1 / St.get_slow_down_factor());
        this._timeline.start();
        global.begin_work();
    }

    stop() {
        this._timeline.stop();
        this._startTime = -1;
        this._currentTime = -1;
        global.end_work();
    }
};
Signals.addSignalMethods(ClutterFrameTicker.prototype);
