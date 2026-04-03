import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';

interface NativeFetchRequest {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

// Bridge object exposed to JavaScript via javaScriptProxy
class FetchBridge {
  webController: webview.WebviewController | null = null;

  // Called from JS: window.NativeBridge.fetch(requestJson)
  fetch(requestJson: string): void {
    if (!this.webController) return;
    let req: NativeFetchRequest;
    try {
      req = JSON.parse(requestJson) as NativeFetchRequest;
    } catch (e) {
      return;
    }
    let ctrl: webview.WebviewController = this.webController;
    let httpRequest: http.HttpRequest = http.createHttp();
    let reqMethod: http.RequestMethod = http.RequestMethod.GET;
    if (req.method === 'POST') reqMethod = http.RequestMethod.POST;
    else if (req.method === 'PUT') reqMethod = http.RequestMethod.PUT;
    else if (req.method === 'DELETE') reqMethod = http.RequestMethod.DELETE;

    let options: http.HttpRequestOptions = {
      method: reqMethod,
      header: req.headers,
      connectTimeout: 10000,
      readTimeout: 10000,
    };
    if (req.body) {
      options.extraData = req.body;
    }

    httpRequest.request(req.url, options).then((resp: http.HttpResponse) => {
      let body: string = typeof resp.result === 'string' ? resp.result : '';
      // Escape for safe JS string embedding
      let escaped: string = body.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      let js: string = `window.__nativeFetchCallback(${req.id}, ${resp.responseCode}, '${escaped}', null)`;
      ctrl.runJavaScript(js);
      httpRequest.destroy();
    }).catch((err: Error) => {
      let errMsg: string = (err.message || 'Network error').replace(/'/g, "\\'");
      let js: string = `window.__nativeFetchCallback(${req.id}, 0, null, '${errMsg}')`;
      ctrl.runJavaScript(js);
      httpRequest.destroy();
    });
  }
}

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  private context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
  private bridge: FetchBridge = new FetchBridge();

  getMimeType(path: string): string {
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.js')) return 'application/javascript';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.wasm')) return 'application/wasm';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    if (path.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  }

  isBinaryFile(path: string): boolean {
    return path.endsWith('.wasm') || path.endsWith('.png') || path.endsWith('.ico') || path.endsWith('.jpg');
  }

  aboutToAppear(): void {
    this.bridge.webController = this.controller;
  }

  build() {
    Column() {
      Web({ src: 'https://local.app/index.html', controller: this.controller })
        .width('100%')
        .layoutWeight(1)
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .onlineImageAccess(true)
        .javaScriptProxy({
          object: this.bridge,
          name: 'NativeBridge',
          methodList: ['fetch'],
          controller: this.controller,
        })
        .onInterceptRequest((event): WebResourceResponse | null => {
          if (!event) return null;
          let url: string = event.request.getRequestUrl();
          let prefix: string = 'https://local.app/';
          if (!url.startsWith(prefix)) return null;
          let path: string = url.substring(prefix.length);
          let qIdx: number = path.indexOf('?');
          if (qIdx >= 0) path = path.substring(0, qIdx);
          if (path === '' || path === undefined) path = 'index.html';

          let mimeType: string = this.getMimeType(path);
          let response: WebResourceResponse = new WebResourceResponse();
          response.setResponseHeader([
            { headerKey: 'Content-Type', headerValue: mimeType },
            { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' }
          ]);

          if (this.isBinaryFile(path)) {
            try {
              let rawData: Uint8Array = this.context.resourceManager.getRawFileContentSync('web/' + path);
              response.setResponseData(rawData.buffer);
            } catch (e) {
              response.setResponseCode(404);
              response.setReasonMessage('Not Found');
              return response;
            }
          } else {
            response.setResponseData($rawfile('web/' + path));
            response.setResponseEncoding('utf-8');
          }

          response.setResponseMimeType(mimeType);
          response.setResponseCode(200);
          response.setReasonMessage('OK');
          return response;
        })
        .onPageEnd(() => {
          // Inject fetch override: external URLs go through NativeBridge.fetch()
          this.controller.runJavaScript(`
            (function() {
              var origFetch = window.fetch;
              var pendingRequests = {};
              var reqId = 0;

              window.__nativeFetchCallback = function(id, status, body, error) {
                var cb = pendingRequests[id];
                if (cb) {
                  delete pendingRequests[id];
                  cb(status, body, error);
                }
              };

              window.fetch = function(url, opts) {
                if (typeof url === 'string' && !url.startsWith('https://local.app/') && (url.startsWith('http://') || url.startsWith('https://'))) {
                  var id = ++reqId;
                  var headers = {};
                  if (opts && opts.headers) {
                    if (opts.headers instanceof Headers) {
                      opts.headers.forEach(function(v, k) { headers[k] = v; });
                    } else if (typeof opts.headers === 'object') {
                      headers = opts.headers;
                    }
                  }
                  try {
                    window.NativeBridge.fetch(JSON.stringify({
                      id: id,
                      url: url,
                      method: (opts && opts.method) || 'GET',
                      headers: headers,
                      body: (opts && opts.body) || null
                    }));
                  } catch(e) {
                    return origFetch.apply(window, arguments);
                  }
                  return new Promise(function(resolve, reject) {
                    var timer = setTimeout(function() {
                      delete pendingRequests[id];
                      reject(new TypeError('Native fetch timeout'));
                    }, 15000);
                    pendingRequests[id] = function(status, body, error) {
                      clearTimeout(timer);
                      if (error) {
                        reject(new TypeError(error));
                      } else {
                        resolve(new Response(body || '', {
                          status: status || 200,
                          headers: { 'Content-Type': 'text/plain' }
                        }));
                      }
                    };
                  });
                }
                return origFetch.apply(window, arguments);
              };
              console.log('[Harmony] Native fetch bridge ready');
            })();
          `);
        })
    }
    .width('100%')
    .height('100%')
  }
}
