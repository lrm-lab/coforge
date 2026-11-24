import { getLocale } from "#src/paraglide/runtime";
import "./whats-new-agent-usage.css";

export function AgentUsageScene() {
  const lang = getLocale() === "zh-CN" ? "zh" : "en";
  return (
    <div className="h-full w-full overflow-hidden">
      <img
        src={`/whats-new/agent-usage-${lang}-light.webp`}
        alt=""
        className="whats-new-usage-light block h-full w-full object-cover object-center"
      />
      <img
        src={`/whats-new/agent-usage-${lang}-dark.webp`}
        alt=""
        className="whats-new-usage-dark block h-full w-full object-cover object-center"
      />
    </div>
  );
}
