import Container from "@/app/[locale]/(routes)/components/ui/Container";
import { BasicView } from "./components/BasicView";
import { getTarget } from "@/actions/crm/get-target";
import { OutreachPanel } from "../components/outreach/OutreachPanel";
import { OutreachQueueNav } from "../components/outreach/OutreachQueueNav";

const TargetViewPage = async (props: any) => {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const { targetId } = params;
  const listId = typeof searchParams?.list === "string" ? searchParams.list : null;
  const target: any = await getTarget(targetId);

  if (!target) return <div>Target not found</div>;

  return (
    <Container
      title={`Target detail view: ${target?.first_name || ""} ${target?.last_name}`}
      description="Everything you need to know about this target"
    >
      <div className="space-y-5">
        <OutreachQueueNav targetId={target.id} listId={listId} />
        <BasicView data={target} />
        <OutreachPanel
          key={target.id}
          target={{
            id: target.id,
            first_name: target.first_name,
            email: target.email,
            mobile_phone: target.mobile_phone,
            social_linkedin: target.social_linkedin,
          }}
        />
      </div>
    </Container>
  );
};

export default TargetViewPage;
