import React from 'react';
import update from 'react-addons-update';

import { isEqualShallow } from './helper.js';
import { contextShape } from './utils/PropTypes';

/**
 * Wraps a react component inside a component that subscribes to queries to the
 * ReduxStore. The wrapping component encapsulates how, when, what and where
 * to fetch the context. The relationship between a subscriber component and
 * ReduxStore is as follows:
 *
 * 1) Wrapper tells ReduxStore the Segment it needs via getSegmentDependencies().
 * 2) Subscriber component may manually query pieces of Segment it has
 *    registered using each Segment's action creator - it gets action creator
 *    from props provided by wrapper component.
 * 3) Subscriber component may subscribe to a query by implementing
 *    subscribeQueries() static method. This will make wrapper sets query result
 *    as props to the subscriber component. Each change in query result will
 *    trigger re-render of the wrapper (via state), and thus setting of new
 *    props to the subscriber component.
 *
 * Subscriber components props and state relationship:
 *
 * 1) Props are given by owner component to the wrapper component.
 * 2) Wrapper component subscribes to queries and update these subscriptions
 *    based on props provided by owner component.
 * 3) Props in wrapper component determines query in wrapper component.
 * 4) Query subscription determines wrapper component's React state.
 * 5) Wrapper component state determines props to subscriber component.
 *
 * @CLIENT_SERVER
 */

/**
 * This method is called at componentWilMount(). Wrapper will register
 * the returned Segment constructors to ReduxStore. Child components must
 * override this static method to specify their data requirements.
 *
 * @return {Array<Class<Segment>>}
 */
var defaultGetSegmentDependencies = function() {
  return [];
};

/**
 * Semantics are very similar to shouldComponentUpdate(). This method
 * determines whether to re-run subscribeQueries() or not when this component
 * will receive new props.
 *
 * Props is the prime determiner of query subscription in DataComponent.
 *
 * Default implementation uses shallowEqual. User can override as needed.
 *
 * @param {Object} prevProps
 * @param {Object} nextProps
 *
 * @CLIENT_SERVER
 */
var defaultShouldSubcriptionsUpdate = function(prevProps, nextProps) {
  var shouldUpdateSubscription = !isEqualShallow(prevProps, nextProps);
  return shouldUpdateSubscription;
};

/**
 * Subscribes to queries to a Segment already registered at
 * getSegmentDependencies().
 *
 * @param {Object} nextProps
 * @param {Function} subscribe
 */
var defaultSubscribeQueries = function(nextProps, subscribe) {

};

/**
 * TODO: Logger at client! Remove if debug is set to false!
 *
 * @param {React.Component} ReactComponent
 * @param {string} name
 * @return {React.Component}
 */
export default function connect(ReactComponent) {
  var connectId = ReactComponent.connectId ? ReactComponent.connectId() : ReactComponent;
  var getSegmentDependencies = ReactComponent.getSegmentDependencies;
  var subscribeQueries = ReactComponent.subscribeQueries;
  var shouldSubscriptionsUpdate = ReactComponent.shouldSubscriptionsUpdate;
  var shouldWrapperComponentUpdate = ReactComponent.shouldWrapperComponentUpdate;
  if (typeof shouldSubscriptionsUpdate !== 'function') shouldSubscriptionsUpdate = defaultShouldSubcriptionsUpdate;
  if (typeof subscribeQueries !== 'function') subscribeQueries = defaultSubscribeQueries;
  if (typeof getSegmentDependencies !== 'function') getSegmentDependencies = defaultGetSegmentDependencies;

  return class Component extends React.Component {
    static contextTypes = {
      context: contextShape,
    };

    /**
     * @type {{[key: string]: Object}}
     */
    __soyaActions;

    /**
     * @type {Function}
     */
    __soyaSubscribe;

    /**
     * @type {{[key: string]: Function}}
     */
    __soyaUnsubscribe;

    /**
     * @type {Function}
     */
    __soyaGetActionCreator;

    /**
     * @type {ReduxStore}
     */
    __soyaGetReduxStore;

    /**
     * @type {Object}
     */
    __soyaGetConfig;

    static getSegmentDependencies() {
      return getSegmentDependencies();
    }

    constructor(props, context) {
      super(props, context);

      // Both actions and unsubscribe is not part of state because it shouldn't
      // affect rendering in any way. Actions are determined at mounting and
      // shouldn't change throughout this component's lifecycle. Unsubscribe
      // contains functions that unsubscribes this component from state changes,
      // but it's the actual state that matters.
      this.__soyaActions = {};
      this.__soyaUnsubscribe = {};
      this.__soyaGetActionCreator = this.getActionCreator.bind(this);
      this.__soyaSubscribe = this.subscribe.bind(this);
      this.__soyaGetReduxStore = this.getReduxStore.bind(this);
      this.__soyaGetConfig = this.getConfig.bind(this);
      this.__soyaContext = props.context || context.context;

      var reduxStore = this.getReduxStore();
      var config = this.getConfig();
      if (!reduxStore || !reduxStore.__isReduxStore) {
        throw new Error('ReduxStore is not properly wired to this data component: ' + ReactComponent + '.');
      }
      if (!config || typeof config != 'object') {
        throw new Error('Config object is not properly wired to this data component: ' + ReactComponent + '.');
      }
    }

    /**
     * Defaults to getting ReduxStore instance from props.store. If you want to
     * use context you can override this method.
     *
     * @returns {ReduxStore}
     */
    getReduxStore() {
      if (this.__soyaContext && this.__soyaContext.store) {
        return this.__soyaContext.store;
      }
      if (this.__soyaContext && this.__soyaContext.reduxStore) {
        console.warn('Please use Page.createContext() to create context instead of creating it by yourself!');
        return this.__soyaContext.reduxStore;
      }
      throw new Error('Context not properly wired to: ' + connectId + '.');
    }

    /**
     * Defaults to getting Config object from props.context. If you want to use
     * context you can override this method.
     *
     * @returns {Object}
     */
    getConfig() {
      if (this.__soyaContext && this.__soyaContext.config) {
        return this.__soyaContext.config;
      }
      throw new Error('Context not properly wired to: ' + connectId + '.');
    }

    /**
     * @param {string} segmentId
     * @param {any} query
     * @param {string} stateName
     * @param {Hydration} hydration
     */
    subscribe(segmentId, query, stateName, hydration) {
      // Unsubscribe if already subscribed.
      this.unsubscribe(stateName);

      //console.log('[SUB] Subscribe', connectId, segmentId);
      var callback = (newState) => {
        this.setState({[stateName]: newState});
      };

      var storeRef = this.getReduxStore().subscribe(
        segmentId, query, callback, this, hydration);
      this.unsubscribe[segmentId] = storeRef.unsubscribe;
      this.setState({
        [stateName]: storeRef.getState()
      });
    }

    /**
     * @param {string} stateName
     */
    unsubscribe(stateName) {
      if (this.__soyaUnsubscribe[stateName]) {
        //console.log('[SUB] Un-subscribe', connectId, stateName);
        this.__soyaUnsubscribe[stateName]();
        delete this.__soyaUnsubscribe[stateName];
      }
    }

    /**
     * Returns action creator of an already registered segment.
     *
     * @param {string} segmentId
     * @return {Object}
     */
    getActionCreator(segmentId) {
      if (!this.__soyaActions.hasOwnProperty(segmentId)) {
        throw new Error('Unable to get action creator for segment \'' + segmentId + '\', segment is not registered.');
      }
      return this.__soyaActions[segmentId];
    }

    connectedProps(props) {
      const nextProps = update(props, { getActionCreator: {$set: this.__soyaGetActionCreator}});
      nextProps.context = this.__soyaContext;
      nextProps.result = this.state;
      nextProps.getReduxStore = this.__soyaGetReduxStore;
      nextProps.getConfig = this.__soyaGetConfig;
      return nextProps;
    }

    render() {
      if (!this.__soyaGetActionCreator) this.__soyaGetActionCreator = this.getActionCreator.bind(this);
      return <ReactComponent {...this.connectedProps(this.props)} />;
    }

    /**
     * @param {Class<Segment>} segmentClass
     */
    _register(segmentClass) {
      var actionCreator = this.getReduxStore().register(segmentClass);
      this.__soyaActions[segmentClass.id()] = actionCreator;
    }

    /**
     * This implementation assumes:
     *
     * 1) All subscriber components render only using props and states (i.e.
     *    they are pure render components). Child classes can override this
     *    method if they are not.
     * 2) All wrapper component owner send their props as immutable objects
     *    (i.e. if the prop changes, they recreate the whole object).
     *
     * Based on the above assumptions, this method will do a shallow comparison
     * of both state and props. Child component can stop re-rendering by
     * creating their own shouldComponentUpdate method.
     *
     * @param {Object} nextProps
     * @param {Object} nextState
     * @return {boolean}
     */
    shouldComponentUpdate(nextProps, nextState) {
      const connectedProps = this.connectedProps(this.props);
      const nextConnectedProps = this.connectedProps(nextProps);
      if (shouldWrapperComponentUpdate) {
        return shouldWrapperComponentUpdate(connectedProps, nextConnectedProps, this.state, nextState);
      }
      var shouldUpdate = !isEqualShallow(connectedProps, nextConnectedProps) || !isEqualShallow(this.state, nextState);
      console.log('[SUB] Should update?', connectId, shouldUpdate);
      return shouldUpdate;
    }

    componentWillUpdate(nextProps, nextState) {
      //console.log('[SUB] Will update', connectId, nextProps, nextState);
    }

    /**
     * @param {Object} nextProps
     */
    componentWillReceiveProps(nextProps) {
      const connectedProps = this.connectedProps(this.props);
      const nextConnectedProps = this.connectedProps(nextProps);
      var shouldUpdateSubscriptions = shouldSubscriptionsUpdate(connectedProps, nextConnectedProps);
      console.log('[SUB] Should subscriptions update', connectId, shouldUpdateSubscriptions);
      if (shouldUpdateSubscriptions) {
        // If query subscriptions update, we need to remove past subscriptions.
        // Otherwise this component may unnecessarily re-render each time the
        // already unrelated segment piece changes. Since this is costly, this
        // is why shouldSubscriptionsUpdate() is important.
        this.getReduxStore().unsubscribe(this);
        subscribeQueries(nextConnectedProps, this.__soyaSubscribe);
      }
    }

    /**
     * Registers the store. Run at both client and server side when rendering.
     */
    componentWillMount() {
      //console.log('[SUB] Mounting', connectId, this.props);
      var i, segmentClasses = getSegmentDependencies();
      for (i = 0; i < segmentClasses.length; i++) {
        this._register(segmentClasses[i]);
      }
      subscribeQueries(this.connectedProps(this.props), this.__soyaSubscribe);
    }

    /**
     * Unsubscribe all segments.
     */
    componentWillUnmount() {
      //console.log('[SUB] Unmounting', connectId);
      this.getReduxStore().unsubscribe(this);
    }
  }
}
