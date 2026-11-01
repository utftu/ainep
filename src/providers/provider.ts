export type ProviderError = {
  status: number;
  message: string;
};

export type ProviderRoute = {
  name: string;
  path: string;
  upstreamPath: string;
  checkBody: (value: unknown) => boolean;
};

export type Provider = {
  id: string;
  origin: string;
  routes: ProviderRoute[];
  validateRequest: (req: Request) => ProviderError | undefined;
  buildHeaders: (req: Request) => Headers;
  buildResponseHeaders: (response: Response) => Headers;
};
