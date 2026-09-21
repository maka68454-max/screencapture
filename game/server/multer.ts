import originalMulter, { Options, Multer } from 'multer';

export function multer(options: Options): Multer {
  const m = originalMulter(options);

  makePromise(m, 'any');
  makePromise(m, 'array');
  makePromise(m, 'fields');
  makePromise(m, 'none');
  makePromise(m, 'single');

  return m;
}

function makePromise(multer: any, name: any): any {
  if (!multer[name]) return;

  const fn = multer[name];

  multer[name] = function () {
    const middleware = Reflect.apply(fn, this, arguments);

    return async (ctx: any, next: any) => {
      await new Promise((resolve, reject) => {
        middleware(ctx.req, ctx.res, (err: any) => {
          if (err) return reject(err);
          if ('request' in ctx) {
            if (ctx.req.body) {
              ctx.request.body = ctx.req.body;
              delete ctx.req.body;
            }

            if (ctx.req.file) {
              ctx.request.file = ctx.req.file;
              ctx.file = ctx.req.file;
              delete ctx.req.file;
            }

            if (ctx.req.files) {
              ctx.request.files = ctx.req.files;
              ctx.files = ctx.req.files;
              delete ctx.req.files;
            }
          }

          resolve(ctx);
        });
      });

      return next();
    };
  };
}

multer.diskStorage = originalMulter.diskStorage;
multer.memoryStorage = originalMulter.memoryStorage;