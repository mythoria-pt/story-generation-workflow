import { describe, expect, it } from '@jest/globals';
import { PrintService } from '@/services/print.js';

const story = {
  title: 'Example cover',
  coverUri: 'https://storage.googleapis.com/example/front.jpg',
  backcoverUri: 'https://storage.googleapis.com/example/back.jpg',
};

describe('print cover layout', () => {
  it('fills the Lulu paperback front panel and anchors the title end of the artwork', () => {
    const print = new PrintService('paperback');
    const html = print.generateCoverHTML(story, print.calculateDimensions(37));

    expect(html).toContain(
      '.front-cover { background-size: cover; background-position: center top; }',
    );
    expect(html).not.toContain('.front-cover::before');
    expect(html).toContain(`background: url("${story.coverUri}");`);
    expect(html).toContain('.back-cover { background-size: cover; }');
  });

  it('starts the back-cover panel at the bleed edge and insets its contents', () => {
    const print = new PrintService('paperback');
    const html = print.generateCoverHTML(story, print.calculateDimensions(37));

    expect(html).toContain(
      '.info-rectangle { left: 0; justify-content: flex-start; padding-left: 16.375mm; }',
    );
    expect(html).toContain('.logo-img { margin-left: 0; }');
  });

  it('retains the casewrap hinge clearance', () => {
    const print = new PrintService('hardcover');
    const html = print.generateCoverHTML(story, print.calculateDimensions(37));

    expect(html).toContain('.front-cover::before');
    expect(html).toContain('inset: 38.1mm 38.1mm 38.1mm 25.4mm;');
    expect(html).toContain(`background: url("${story.coverUri}") center / contain no-repeat;`);
  });
});
