import { plugin } from 'bun';
const adapter = new URL('./docker-task-session.ts', import.meta.url).pathname;
plugin({name:'eval-docker-task-session',setup(build){
  build.onLoad({filter:/\/benchmark\/evolbench-collab\/src\/eval-daemon\.ts$/},async({path})=>{
    const source=await Bun.file(path).text();
    const needle='const session = await create(options);';
    if(source.split(needle).length!==2)throw new Error('eval Docker Task injection point changed');
    return {loader:'ts',contents:source.replace(needle,`const session = options.agentId === input.workspace.taskAgentId && Bun.env.COFORGE_EVAL_DOCKER_TASK_CONTAINER
      ? await (await import(${JSON.stringify(adapter)})).createDockerTaskSession(options)
      : await create(options);`)};
  });
}});
