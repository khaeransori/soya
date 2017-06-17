import Compiler from './compiler/Compiler';
import Router from './router/Router';
import EntryPoint from './EntryPoint';
import ServerHttpRequest from './http/ServerHttpRequest';
import Provider from './Provider.js';
import CookieJar from './http/CookieJar.js';
import ServerCookieJar from './http/ServerCookieJar.js';

import fs from 'fs';
import path from 'path';
import http from 'http';
import domain from 'domain';

/**
 * Orchestrates all the things that makes the application server run:
 *
 * 1. Gets the list of entry points from ComponentRegister.
 * 2. Compiles the code with the given Compiler implementation.
 * 3. Create and run the server.
 * 4. Handles the requests.
 *
 * In handling the requests:
 *
 * 1. Passes request and response to middlewares generated by Compiler.
 * 2. If not handled, Compiler middlewares will call next, which will pass
 *    the torch to soya middleware.
 * 3. Soya middleware will ask Router which page to run, ask Page to render,
 *    ask Compiler to assemble HTML and send response.
 *
 * Uses node-js domain for error handling.
 *
 * TODO: Make every process async with Promise?
 *
 * This object is stateless, should not store ANY request-specific states.
 *
 * @SERVER
 */
export default class Application {
  /**
   * @type {Object}
   */
  _routeForPages;

  /**
   * @type {Router}
   */
  _router;

  /**
   * @type {Object}
   */
  _frameworkConfig;

  /**
   * @type {Object}
   */
  _serverConfig;

  /**
   * @type {Object}
   */
  _clientConfig;

  /**
   * @type {Compiler}
   */
  _compiler;

  /**
   * @type {CompileResult}
   */
  _compileResult;

  /**
   * @type {ComponentRegister}
   */
  _componentRegister;

  /**
   * @type {Array<EntryPoint>}
   */
  _entryPoints;

  /**
   * @type {ErrorHandler}
   */
  _errorHandler;

  /**
   * @type {Logger}
   */
  _logger;

  /**
   * @type {Provider}
   */
  _provider;

  /**
   * @type {{[key: string]: Function}}
   */
  _pageClasses;

  /**
   * The idea is to have middleware system that is compatible with express
   * middlewares. Since express middlewares are just functions accepting req,
   * res, and next - it should not be hard to make it compatible.
   * Kudos to the express team to make such an awesome framework btw.
   *
   * @type {Array<Function>}
   */
  _middlewares;

  /**
   * @type {boolean}
   */
  _serverCreated;

  /**
   * @param {Logger} logger
   * @param {ComponentRegister} componentRegister
   * @param {Object} routes
   * @param {Router} router
   * @param {Compiler} compiler
   * @param {ErrorHandler} errorHandler
   * @param {ReverseRouter} reverseRouter
   * @param {Object} frameworkConfig
   * @param {Object} serverConfig
   * @param {Object} clientConfig
   */
  constructor(logger, componentRegister, routes, router, reverseRouter, errorHandler,
              compiler, frameworkConfig, serverConfig, clientConfig) {
    // Change register to real client registration function.
    this._addReplace(frameworkConfig, 'soya/lib/client/Register', 'soya/lib/client/RegisterClient');

    // Change react renderer to client version.
    this._addReplace(frameworkConfig, 'soya/lib/page/react/ReactRenderer', 'soya/lib/page/react/ReactRendererClient');

    // Allow users to run code blocks on server or client.
    this._addReplace(frameworkConfig, 'soya/lib/scope', 'soya/lib/scope-client');

    // Replace custom node registration function for client.
    if (frameworkConfig.routerNodeRegistrationAbsolutePath) {
      this._addReplace(frameworkConfig, 'soya/lib/server/registerRouterNodes', frameworkConfig.routerNodeRegistrationAbsolutePath);
    }

    this._logger = logger;
    this._serverCreated = false;
    this._componentRegister = componentRegister;
    this._compiler = compiler;
    this._frameworkConfig = frameworkConfig;
    this._serverConfig = serverConfig;
    this._clientConfig = clientConfig;
    this._router = router;
    this._errorHandler = errorHandler;
    this._pages = {};
    this._routeForPages = {};
    this._entryPoints = [];
    this._pageClasses = {};
    this._provider = new Provider(serverConfig, reverseRouter, true);
    this._absoluteClientDepFile = path.join(this._frameworkConfig.absoluteProjectDir, 'build/client/dep.json');

    var cookieJar = new CookieJar();
    var i, pageCmpt, page, pageComponents = componentRegister.getPages();
    var routeRequirements, j, routeId;

    for (i in pageComponents) {
      if (!pageComponents.hasOwnProperty(i)) continue;
      pageCmpt = pageComponents[i];

      // Create entry point.
      this._entryPoints.push(new EntryPoint(pageCmpt.name, pageCmpt.absDir));
      this._pageClasses[pageCmpt.name] = pageCmpt.clazz;

      try {
        // Instantiate page. We try to instantiate page at startup to find
        // potential problems with each page. This allows us to detect factory
        // naming clash early on while also allowing the start-up process to
        // populate Provider with ready to use dependencies.
        page = new pageCmpt.clazz(this._provider, cookieJar, true);
      } catch (e) {
        throw e;
      }

      this._routeForPages[pageCmpt.name] = {};
      if (typeof pageCmpt.clazz.getRouteRequirements == 'function') {
        routeRequirements = pageCmpt.clazz.getRouteRequirements();
        for (j = 0; j < routeRequirements.length; j++) {
          routeId = routeRequirements[j];
          if (!routes.hasOwnProperty(routeId)) {
            throw new Error('Page ' + pageCmpt.name + ' has dependencies to unknown route: ' + routeId + '.');
          }
          this._routeForPages[pageCmpt.name][routeId] = routes[routeId];
        }
      }
    }

    this._middlewares = [];
  }

  /**
   * @param {Object} frameworkConfig
   * @param {string} source
   * @param {string} replacement
   */
  _addReplace(frameworkConfig, source, replacement) {
    frameworkConfig.clientReplace[source] = replacement;
    frameworkConfig.clientReplace[source + '.js'] = replacement;
  }

  /**
   * Compiles and then create an http server that handles requests.
   */
  start() {
    // If precompileClient true, try get page dependency map from previously generated dep.json to
    // fill this._compileResult
    if (this._frameworkConfig.precompileClient && fs.existsSync(this._absoluteClientDepFile)) {
      this._middlewares = this._compiler.run(this._entryPoints, null, false);
      this._compileResult = JSON.parse(fs.readFileSync(this._absoluteClientDepFile));
      this.createServer();
    } else {
      // Runs runtime compilation. This will update compilation result when
      // compilation is done, while returning array of compiler specific
      // middlewares for us.
      this._middlewares = this._compiler.run(this._entryPoints, compileResult => {
        this._compileResult = compileResult;
        this.createServer();
      });
    }

    // Add soya middleware as the last one.
    this._middlewares.push(this.handle.bind(this));
  }

  /**
   * Do mostly the same work as start(), except this doesn't createServer() and write compile result to dep.json
   */
  buildClient() {
    this._compiler.run(this._entryPoints, compileResult => {
      fs.writeFileSync(this._absoluteClientDepFile, JSON.stringify(compileResult), 'utf8');
    });
  }

  createServer() {
    if (this._serverCreated) {
      // No need to create more than one server.
      return;
    }

    // No need to listen twice.
    this._serverCreated = true;

    // TODO: Config can set timeout for http requests.
    http.createServer((request, response) => {
      // Control for favicon
      if (request.method === 'GET' && request.url === '/favicon.ico') {
        var faviconPath = path.join(this._frameworkConfig.absoluteProjectDir, 'favicon.ico');
        if (fs.existsSync(faviconPath)) {
          response.writeHead(200, {'Content-Type': 'image/x-icon'});
          response.end(fs.readFileSync(faviconPath), 'binary');
          return;
        }
      }
      var d = domain.create().on('error', (error) => {
        this.handleError(error, request, response);
      });
      d.run(() => {
        var index = 0;
        var runMiddleware = () => {
          var middleware = this._middlewares[index++];
          if (!middleware) return;
          middleware(request, response, runMiddleware);
        };

        // Run the first middleware.
        runMiddleware();
      });
    }).listen(this._frameworkConfig.port, () => {
      if (process && typeof process.send === 'function') process.send('ready');
      this._logger.info('Server listening at port: ' + this._frameworkConfig.port + '.');
    });
  }

  /**
   * @param {http.incomingMessage} request
   * @param {httpServerResponse} response
   */
  handle(request, response) {
    var httpRequest = new ServerHttpRequest(request, this._frameworkConfig.maxRequestBodyLength);
    var routeResult = this._router.route(httpRequest);
    if (routeResult == null) {
      throw new Error('Unable to route request, router returned null');
    }

    var pageClass = this._pageClasses[routeResult.pageName];
    if (!pageClass) {
      throw new Error('Unable to route request, page ' + routeResult.pageName + ' doesn\'t exist');
    }

    // Because we tried to instantiate all pages at start-up we can be sure
    // that pageClass exists.
    var cookieJar = new ServerCookieJar(request);
    var page = new pageClass(this._provider, cookieJar, true);
    var store = page.createStore(null);

    this._logger.debug('Rendering page: ' + routeResult.pageName + '.', null);
    page.render(httpRequest, routeResult.routeArgs, store,
      this._handleRenderResult.bind(this, routeResult, request, httpRequest, response, store, cookieJar));
  }

  /**
   * @param {RouteResult} routeResult
   * @param {http.incomingMessage} request
   * @param {ServerHttpRequest} httpRequest
   * @param {httpServerResponse} response
   * @param {void | Store} store
   * @param {ServerCookieJar} cookieJar
   * @param {RenderResult} renderResult
   */
  _handleRenderResult(routeResult, request, httpRequest, response, store, cookieJar, renderResult) {
    var pageDep = this._compileResult.pages[routeResult.pageName];
    if (!pageDep) {
      throw new Error('Unable to render page server side, dependencies unknown for entry point: ' + routeResult.componentName);
    }

    var promise = Promise.resolve(null);

    if (store) {
      if (store._shouldRenderBeforeServerHydration()) {
        store._startRender();
        // Render first to let all segment and query requirements registered
        // to the store. This is weird and sort of wasteful, but we haven't
        // found a better way yet.
        renderResult.contentRenderer.render(
          routeResult.routeArgs, this._routeForPages[routeResult.pageName],
          this._clientConfig, null, pageDep);
        store._endRender();
      }

      //this._logger.debug('Store requirements gathered, start hydration.', null, store);
      promise = store.hydrate();
    }

    var handlePromiseError = (error) => {
      // Just in case user store code doesn't reject with Error object.
      error = this._ensureError(error);
      this.handleError(error, request, response);
    };

    var storeResolve = () => {
      var state = null;
      if (store) {
        state = store._getState();
        //this._logger.debug('Finish hydration.', null, state);
        store._startRender();
      }

      var htmlResult = renderResult.contentRenderer.render(
        routeResult.routeArgs, this._routeForPages[routeResult.pageName],
        this._clientConfig, state, pageDep);

      if (store) store._endRender();

      response.statusCode = renderResult.httpStatusCode;
      response.statusMessage = renderResult.httpStatusMessage;

      // TODO: Calculating content length as utf8 is hard-coded. This might be harmful, maybe move as configuration of the compiler?
      response.setHeader('Content-Length', Buffer.byteLength(htmlResult, 'utf8'));
      response.setHeader('Content-Type', 'text/html;charset=UTF-8');

      // Set result headers.
      var key, headerData = renderResult.httpHeaders.getAll();
      for (key in headerData) {
        if (!headerData.hasOwnProperty(key)) continue;
        response.setHeader(key, headerData[key]);
      }

      // Set result cookies.
      var cookieValues = cookieJar.generateHeaderValues();
      if (cookieValues.length > 0) {
        response.setHeader('Set-Cookie', cookieValues);
      }

      // Set result content.
      response.end(htmlResult);
    };

    promise.then(storeResolve).catch(handlePromiseError);
  }

  /**
   * @param {Error} error
   * @param {http.incomingRequest} request
   * @param {httpServerResponse} response
   */
  handleError(error, request, response) {
    if (response.headersSent) {
      this._errorHandler.responseSentError(error, request, response);
      return;
    }

    this._errorHandler.responseNotSentError(error, request, response);
  }

  /**
   * @param {any} error
   * @return {Error}
   */
  _ensureError(error) {
    if (error instanceof Error) return error;
    if (typeof error == 'string') return new Error(error);
    return new Error('Error when resolving store promise! Unable to convert reject arg: ' + error);
  }
}
