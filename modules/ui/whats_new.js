import { marked } from 'marked';

import { icon } from './intro/helper.js';
import { uiModal } from './modal.js';


/**
 * uiWhatsNew
 * This is the "whats new" screen we show to the users if:
 *   - They have used Rapid before and seen the welcome screen
 *   - They do not have backup changes to restore
 */
export function uiWhatsNew(context) {
  const assets = context.systems.assets;
  const l10n = context.systems.l10n;
  const storage = context.systems.storage;


  return function render(selection) {
    const $modal = uiModal(selection);
    const rtl = l10n.isRTL() ? '-rtl' : '';

    let version;
    const match = context.version.match(/(\d+\.\d+)/);  // first match should be major,minor
    if (match !== null) {
      version = `v${match[1]}`;
    } else {
      version = context.version.toString();
    }

    $modal.select('.modal')
      .attr('class', 'modal rapid-modal modal-whatsnew');

    const $content = $modal.select('.content');
    $content
      .append('div')
      .attr('class', 'modal-section')
      .append('h2')
      .html(l10n.t('splash.welcome', {
        rapidicon: icon(`#rapid-logo-rapid-wordmark${rtl}`, 'pre-text rapid'),
        version: version
      }));


    const markdown = l10n.t('whats_new.text_v25') + '\n\n' + l10n.t('whats_new.project_links') + '\n\n';

    const $mainSection = $content
      .append('div')
      .attr('class', 'modal-section');

    $mainSection
      .append('div')
      .attr('class', 'whatsnew-text')
      .html(marked.parse(markdown));

    $mainSection
      .append('div')
      .attr('class', 'whatsnew-images')
// if an image:
      .append('img')
      .attr('class', 'whatsnew-image')
      .attr('src', assets.getFileURL('img/rapid-v25-curbs.gif'));
// if a video:
//      .append('video')
//      .attr('class', 'whatsnew-image')
//      .attr('width', '660')
//      .attr('muted', '')
//      .attr('controls', '')
//      .attr('loop', '')
//      .attr('playsinline', '')
//      .attr('disablepictureinpicture', '')
//      .attr('poster', assets.getFileURL('img/rapid-v23-rotation.jpg'))
//      .attr('src', assets.getFileURL('img/rapid-v23-rotation.mp4'))
//      .attr('autoplay', '');

    const $checkbox = $mainSection
      .append('div')
      .attr('class', 'rapid-checkbox whatsnew-dontshow')
      .append('label')
      .attr('class', 'rapid-checkbox-label');

    $checkbox
      .append('span')
      .attr('class', 'rapid-checkbox-text')
      .text(l10n.t('whats_new.dontshowagain'));

    $checkbox
      .append('input')
      .attr('type', 'checkbox')
      .attr('class', 'rapid-feature-checkbox')
      .on('click', e => {
        if (e.target.checked) {
          storage.setItem('sawWhatsNewVersion', context.whatsNewVersion);
        } else {
          storage.removeItem('sawWhatsNewVersion');
        }
      });

    $checkbox
      .append('div')
      .attr('class', 'rapid-checkbox-custom');


    // outbound links should open in new tab
    $content.selectAll('a')
      .attr('target', '_blank');


    const $buttonWrap = $content
      .append('div')
      .attr('class', 'modal-section buttons');

    $buttonWrap
      .append('button')
      .attr('class', 'button ok-button action')
      .text(l10n.t('confirm.okay'))
      .on('click', $modal.close)
      .node()
      .focus();
  };
}
