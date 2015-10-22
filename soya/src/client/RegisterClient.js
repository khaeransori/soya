import SoyaClient from './SoyaClient';

/**
 * @CLIENT
 * @param {Page} pageClass
 */
export default function register(pageClass) {
  if (!window.__soyaClient) {
    // This follows an implicit contract between renderer and client runtime.
    // Config and RouteArgs must be present as a global variable.
    // Haven't found the better way to do this yet.
    var config = window.config;
    var routeArgs = window.routeArgs;
    var routes = window.routes;

    // Start and load the page.
    window.__soyaClient = new SoyaClient(config);
    window.__soyaClient.addRouteConfig(routes);
    window.__soyaClient.register(pageClass);
    window.__soyaClient.navigate(pageClass.name, routeArgs);
    return;
  }

  // TODO: Implement History API page navigation!
  window.__soyaClient.register(pageClass);
}