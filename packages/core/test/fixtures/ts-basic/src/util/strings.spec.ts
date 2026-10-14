// A test file: excluded from scans by default, included with includeTests=true.
import { capitalize, slugify } from './strings.js';

export function checkSlugify(): boolean {
  return slugify('Hello World') === 'hello-world';
}

export function checkCapitalize(): boolean {
  return capitalize('ada') === 'Ada';
}
