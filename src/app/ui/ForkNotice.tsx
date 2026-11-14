import { tx } from '../../i18n';
import { Note } from './kit';
import '../online/words';

export function ForkNotice() {
  return (
    <div data-test="fork-notice">
      <Note>
        <strong>{tx('on.studyNotice')}</strong>
      </Note>
      <Note>{tx('on.rightsNotice')}</Note>
      <Note>{tx('on.appleServiceHelp')}</Note>
    </div>
  );
}
