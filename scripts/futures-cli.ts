import { config, readState, queueCommand } from '../src/server/store';
import { report } from '../src/core/engine';
const command=process.argv[2]??'status';
if(['pause','resume','flatten'].includes(command)) {
 const action=command as 'pause'|'resume'|'flatten';
 queueCommand(action);console.log(`${action} queued for the local futures simulator. No broker action.`);
} else if(command==='status') {
 const c=config(),s=readState(c);console.log(JSON.stringify({mode:s.mode,provenance:s.provenance,paused:s.paused,halt:s.halt,position:s.position,report:report(s,c)},null,2));
} else if(command==='logs') {
 for(const e of readState(config()).events.slice(-50))console.log(`${new Date(e.time).toISOString()} ${e.kind} ${e.message}`);
} else {
 console.log('Uriel futures: start, stop, status, logs, pause, resume, flatten. Controls are local simulation only.');
 if(command!=='help')process.exitCode=1;
}
