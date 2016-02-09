// Proxy HTTP requests

import * as http from 'http';
import * as url from 'url';
import * as request from 'request';
import * as events from 'events';
import * as assert from 'assert';
import { PassthroughStream } from './stream-adaptor';
import { BufferFilter, StreamFilter, FileFilter, FilterChain } from './filter-chain';
import { randomString } from './util';
let headerCaseNormalizer: any = require('header-case-normalizer');

export type ProxyRequestHandler = (ctx: RequestContext) => void;

export function getRequestUrl(req: http.IncomingMessage): string {
    let parsedUrl = url.parse(req.url),
        scheme = (<any> req).connection.encrypted ? 'https' : 'http',
        host = req.headers['host'] || parsedUrl.host;

    return scheme + '://' + host + parsedUrl.path;
}

function createProxyRequest(req: http.IncomingMessage, options?: HttpHandlerOptions): request.Request {
    let destUrl = getRequestUrl(req);

    let filteredHeaders: { [k: string]: string } = {};
    delete req.headers['proxy-connection'];

    Object.keys(req.headers).forEach((k: string) => {
        let nk = headerCaseNormalizer(k); // TODO: HACK
        filteredHeaders[nk] = req.headers[k];
    });

    options = options || {};
    let reqOpts = {
        url: destUrl,
        strictSSL: options.strictSSL,
        proxy: options.proxy,
        method: req.method,
        followRedirect: false,
        headers: filteredHeaders
    };
    return request(reqOpts);
}

export interface HttpHandlerOptions {
    proxy?: string;
    strictSSL?: boolean;
}

export class HttpHandler extends events.EventEmitter {
    handlers: ProxyRequestHandler[] = [];

    constructor(public options: HttpHandlerOptions) {
        super();
    }
    addHandler(h: ProxyRequestHandler) {
        this.handlers.push(h);
    }
    clearHandlers() {
        this.handlers = [];
    }
    async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let ctx = new RequestContext(getRequestUrl(req));
        ctx.on('error', (e: any) => this.handleError(e, res));
        try {
            this.handlers.forEach(h => h(ctx));
            let requestStream = await ctx._handleRequest(req);
            let proxyReq = createProxyRequest(req);
            proxyReq.on('error', (e: any) => this.handleError(e, res));
            requestStream.pipe(new PassthroughStream()).pipe(proxyReq); // Suppress 'request' library cleverness
            proxyReq.on('response', async (serverRes: http.IncomingMessage) => {
                serverRes.pause();
                try {
                    let responseStream = await ctx._handleResponse(serverRes);
                    res.writeHead(serverRes.statusCode, serverRes.statusMessage, serverRes.headers);
                    responseStream.pipe(res);
                } catch (e) {
                    this.handleError(e, res);
                }
            });
        } catch (e) {
            this.handleError(e, res);
        }
    }
    private handleError(e: any, res: http.ServerResponse) {
        res.writeHead(500, 'Internal proxy error');
        res.end('PROXY ERROR: ' + e);
        this.emit('error', e);
    }
}

export type MessageHandler = (msg: http.IncomingMessage) => void;

enum RequestState {
    START = 0,
    GOT_REQUEST = 1,
    GOT_RESPONSE = 2
}

export class RequestContext extends events.EventEmitter {
    id = randomString(8);
    private state = RequestState.START;
    private reqHandlers: MessageHandler[] = [];
    private resHandlers: MessageHandler[] = [];
    private reqFilters = new FilterChain();
    private resFilters = new FilterChain();

    constructor(public url: string) {
        super();
        this.reqFilters.on('error', (e: any) => this.emit('error', e));
        this.resFilters.on('error', (e: any) => this.emit('error', e));
    }
    withRequest(fn: MessageHandler) {
        this.reqHandlers.push(fn);
    }
    withResponse(fn: MessageHandler) {
        this.resHandlers.push(fn);
    }
    withRequestBuffer(h: BufferFilter) {
        this._deferUntilRequest(() => this.reqFilters.addBufferFilter(h));
    }
    withRequestStream(h: StreamFilter) {
        this._deferUntilRequest(() => this.reqFilters.addStreamFilter(h));
    }
    withRequestFile(h: FileFilter) {
        this._deferUntilRequest(() => this.reqFilters.addFileFilter(h));
    }
    withResponseStream(h: StreamFilter) {
        this._deferUntilResponse(() => this.resFilters.addStreamFilter(h));
    }
    withResponseBuffer(h: BufferFilter) {
        this._deferUntilResponse(() => this.resFilters.addBufferFilter(h));
    }
    withResponseFile(h: FileFilter) {
        this._deferUntilResponse(() => this.resFilters.addFileFilter(h));
    }
    _handleRequest(req: http.IncomingMessage): Promise<NodeJS.ReadableStream> {
        assert.equal(this.state, RequestState.START);
        this.state = RequestState.GOT_REQUEST;
        this.reqHandlers.forEach(fn => fn(req));
        return this.reqFilters.run(req);
    }
    _handleResponse(resp: http.IncomingMessage): Promise<NodeJS.ReadableStream> {
        assert.equal(this.state, RequestState.GOT_REQUEST);
        this.state = RequestState.GOT_RESPONSE;
        this.resHandlers.forEach(fn => fn(resp));
        return this.resFilters.run(resp);
    }
    // The need to defer here is a bit subtle. Basically some middleware (e.g. decompressor) will call
    // withResponse(...), examine headers and conditionally modify a response. On the other hand, our API allows
    // middleware to just call withResponse{Buffer/File/Stream} without stopping to look at the headers. If it
    // is doing that, we transparently wrap it in withRequest() or withResponse(), to ensure that handlers always
    // run in the right order.
    private _deferUntilRequest(fn: () => void): void {
        if(this.state === RequestState.GOT_REQUEST) {
            fn();
        } else {
            this.withRequest(() => fn());
        }
    }
    private _deferUntilResponse(fn: () => void): void {
        if(this.state === RequestState.GOT_RESPONSE) {
            fn();
        } else {
            this.withResponse(() => fn());
        }
    }
}
