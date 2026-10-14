import { createUser } from './models/user.js';
import { ReportEngine } from './services/report-engine.js';
import { UserService } from './services/user-service.js';
import { slugify } from './util/strings.js';

export function bootstrap(): { service: UserService; engine: ReportEngine } {
  const service = new UserService();
  service.register('Ada Lovelace', 'admin');
  const engine = new ReportEngine({ currency: 'EUR', locale: 'en' });
  engine.addRow({ id: slugify('first row'), owner: createUser('Grace').id, amount: 10, category: 'misc', at: 0 });
  return { service, engine };
}
