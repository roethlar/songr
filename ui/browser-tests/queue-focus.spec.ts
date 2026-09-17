import { expect, test } from '@playwright/test';

test('active queue settings retain a distinct visible keyboard outline', async ({ page }) => {
 await page.goto('/library/browse?shell=1&grouped=1');
 await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
 await page.getByRole('button', { name: 'Queue', exact: true }).click();
 const queue = page.getByRole('dialog', { name: 'Queue' });
 const shuffle = queue.getByRole('button', { name: 'Shuffle', exact: true });
 await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
 await shuffle.focus();
 await page.keyboard.press('Tab');
 await page.keyboard.press('Shift+Tab');
 await expect(shuffle).toBeFocused();
 await expect(async () => {
 const appearance = await shuffle.evaluate(button => {
  const style = getComputedStyle(button);
  const reference = document.createElement('span');
  reference.style.color = 'var(--songr-queue-text)';
  button.append(reference);
  const expectedColor = getComputedStyle(reference).color;
  reference.remove();
  return { visible: button.matches(':focus-visible'), width: style.outlineWidth,
   style: style.outlineStyle, color: style.outlineColor, expectedColor };
 });
 expect(appearance.visible).toBe(true);
 expect(appearance.width).toBe('1px');
 expect(appearance.style).toBe('solid');
 expect(appearance.color).toBe(appearance.expectedColor);
 }).toPass({ timeout: 5000 });
});
