export type TestImageSelection = "extras" | "primary" | "text";

/** Rendering failure must not suppress the test's chapter notification. */
export async function selectPairTestImage({
  captured,
  renderPair,
  renderPrimary,
  report = async (_message: string) => {},
  onFailure = (_stage: "extras" | "primary", _error: unknown) => {},
}: {
  captured?: Buffer | null;
  renderPair: () => Promise<Buffer | null>;
  renderPrimary: () => Promise<Buffer | null>;
  report?: (message: string) => Promise<void>;
  onFailure?: (stage: "extras" | "primary", error: unknown) => void;
}): Promise<{ image: Buffer | null; selection: TestImageSelection; browser: boolean }> {
  if (captured?.length) return { image: captured, selection: "extras", browser: true };
  try {
    const image = await renderPair();
    if (image?.length) return { image, selection: "extras", browser: false };
  } catch (error) { onFailure("extras", error); }
  await report("As duas extras ficaram indisponíveis; tentando a imagem principal do mesmo capítulo como reserva.");
  try {
    const image = await renderPrimary();
    if (image?.length) return { image, selection: "primary", browser: false };
  } catch (error) { onFailure("primary", error); }
  await report("A imagem principal também ficou indisponível; o aviso será enviado somente em texto.");
  return { image: null, selection: "text", browser: false };
}