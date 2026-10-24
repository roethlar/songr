import { decideNavigation } from '../navigationPolicy';
import { abs, fileUrl } from './support/platformPaths';

const ENGINE = 'http://127.0.0.1:51981';
const PAGES = abs('/app/resources');

describe('decideNavigation (dt2-2, dt3-3)', () => {
  it('allows the engine origin', () => {
    expect(decideNavigation(`${ENGINE}/library`, ENGINE, PAGES)).toBe('allow');
  });

  it('allows the shell pages inside the resources directory only', () => {
    expect(
      decideNavigation(`${fileUrl('/app/resources/error.html')}?reason=x`, ENGINE, PAGES),
    ).toBe('allow');
    expect(
      decideNavigation(fileUrl('/app/resources/starting.html'), ENGINE, PAGES),
    ).toBe('allow');
  });

  it('denies file URLs outside the resources directory (dt3-3)', () => {
    expect(decideNavigation(fileUrl('/etc/passwd'), ENGINE, PAGES)).toBe('deny');
    expect(
      decideNavigation(fileUrl('/app/resources/../main.js'), ENGINE, PAGES),
    ).toBe('deny');
    expect(decideNavigation(fileUrl('/app/resources'), ENGINE, PAGES)).toBe(
      'deny',
    );
  });

  it('denies every file URL when no page directory is configured', () => {
    expect(
      decideNavigation(fileUrl('/app/resources/error.html'), ENGINE, null),
    ).toBe('deny');
  });

  it('sends web links to the external browser, not the app frame', () => {
    expect(decideNavigation('https://roonlabs.com/', ENGINE, PAGES)).toBe(
      'open-external',
    );
    expect(decideNavigation('http://example.com/', ENGINE, PAGES)).toBe(
      'open-external',
    );
  });

  it('treats a different local port as external, not the engine', () => {
    expect(decideNavigation('http://127.0.0.1:9999/', ENGINE, PAGES)).toBe(
      'open-external',
    );
  });

  it('denies non-web schemes outright', () => {
    expect(decideNavigation('javascript:alert(1)', ENGINE, PAGES)).toBe('deny');
    expect(decideNavigation('roon://something', ENGINE, PAGES)).toBe('deny');
  });

  it('denies unparseable URLs', () => {
    expect(decideNavigation('not a url', ENGINE, PAGES)).toBe('deny');
  });

  it('never treats web content as the engine before a port exists', () => {
    expect(decideNavigation('http://127.0.0.1:51981/', null, PAGES)).toBe(
      'open-external',
    );
  });
});
