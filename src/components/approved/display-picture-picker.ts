export type CatalogPictureRecovery = 'hidden-option' | 'fallback' | 'hidden-image';

export function recoverCatalogPicture(image: HTMLImageElement, fallbackUrl: string): CatalogPictureRecovery {
  const option = image.closest<HTMLElement>('.catalog-picture');
  if (option) {
    const input = option.querySelector<HTMLInputElement>('input[name="catalog-picture"]');
    // Keep an existing saved selection intact until the user explicitly chooses
    // another picture. Broken unselected entries must not be submitted.
    if (input && !input.checked) input.disabled = true;
    option.hidden = true;
    return 'hidden-option';
  }

  if (image.dataset.fallback) {
    image.hidden = true;
    return 'hidden-image';
  }
  image.dataset.fallback = 'true';
  image.src = fallbackUrl;
  return 'fallback';
}
