import { computeUniverseFromLine, CRendererEndpoint, minIgnoringNulls, nodeTransformFromMat4, nodeTransformToMat4, scaleAxisToFit, scaleMat, vec3MultiplyAndAdd } from '@aardvarkxr/aardvark-react';
import { Av, AvActionState, AvConstraint, AvModelInstance, AvNode, AvNodeTransform, AvNodeType, AvRendererConfig, EHand, emptyActionState, EndpointAddr, endpointAddrsMatch, endpointAddrToString, EndpointType, ENodeFlags, Envelope, EVolumeType, filterActionsForGadget, g_builtinModelCylinder, g_builtinModelError, g_builtinModelPanel, g_builtinModelPanelInverted, MessageType, MsgInterfaceEnded, MsgInterfaceLock, MsgInterfaceLockResponse, MsgInterfaceReceiveEvent, MsgInterfaceRelock, MsgInterfaceRelockResponse, MsgInterfaceSendEvent, MsgInterfaceSendEventResponse, MsgInterfaceStarted, MsgInterfaceTransformUpdated, MsgInterfaceUnlock, MsgInterfaceUnlockResponse, MsgLostEndpoint, MsgNodeHaptic, MsgResourceLoadFailed, MsgUpdateActionState, MsgUpdateSceneGraph, parseEndpointFieldUri } from '@aardvarkxr/aardvark-shared';
import { mat4, vec3, vec4 } from '@tlaukkan/tsm';
import bind from 'bind-decorator';
import { EndpointAddrMap } from './endpoint_addr_map';
import { CInterfaceProcessor, InterfaceEntity, InterfaceProcessorCallbacks } from './interface_processor';
import { TransformedVolume } from './volume_intersection';
const equal = require( 'fast-deep-equal' );

interface NodeData
{
	lastModelUri?: string;
	lastFailedModelUri?: string;
	modelInstance?: AvModelInstance;
	lastParentFromNode?: mat4;
	constraint?: AvConstraint;
	lastFlags?: ENodeFlags;
	lastFrameUsed: number;
	nodeType: AvNodeType;
	lastNode?: AvNode;
	transform0?: AvNodeTransform;
	transform0Time?: number;	
	transform1?: AvNodeTransform;
	transform1Time?: number;	
	graphParent?: EndpointAddr;
	lastVisible?: boolean;
}



interface TransformComputeFunction
{
	( universeFromParents: mat4[], parentFromNode: mat4 ): mat4;
}

class PendingTransform
{
	private m_id: string;
	private m_needsUpdate = true;
	private m_parents: PendingTransform[] = null;
	private m_parentFromNode: mat4 = null;
	private m_universeFromNode: mat4 = null;
	private m_applyFunction: (universeFromNode: mat4) => void = null;
	private m_computeFunction: TransformComputeFunction = null;
	private m_currentlyResolving = false;
	private m_originPath: string = null;

	constructor( id: string )
	{
		this.m_id = id;
	}

	public resolve()
	{
		if( this.m_universeFromNode )
		{
			return;
		}

		if( this.m_needsUpdate )
		{
			console.log( "Pending transform needs an update in resolve");
			this.m_parentFromNode = mat4.identity;
		}
		
		if( this.m_currentlyResolving )
		{
			throw "Loop in pending transform parents";
		}

		this.m_currentlyResolving = true;

		if( this.m_parents )
		{
			let universeFromParents: mat4[] = [];
			for( let parent of this.m_parents )
			{
				parent.resolve();
				universeFromParents.push( parent.m_universeFromNode );
			}

			if( this.m_computeFunction )
			{
				this.m_universeFromNode = this.m_computeFunction( universeFromParents, 
					this.m_parentFromNode );
			}
			else
			{
				this.m_universeFromNode = new mat4;
				mat4.product( universeFromParents[ 0 ], this.m_parentFromNode, 
					this.m_universeFromNode );
			}
		}
		else
		{
			this.m_universeFromNode = this.m_parentFromNode;
		}

		this.m_currentlyResolving = false;

		if( this.m_applyFunction )
		{
			this.m_applyFunction( this.m_universeFromNode );
		}

	}

	public setOriginPath( originPath: string )
	{
		this.m_originPath = originPath;
	}

	public getOriginPath(): string
	{
		if( this.m_originPath )
		{
			return this.m_originPath;
		}
		else if( this.m_parents && this.m_parents.length > 0 )
		{
			return this.m_parents[0].getOriginPath();
		}
		else
		{
			return null;
		}
	}


	public getUniverseFromNode():mat4
	{
		return this.m_universeFromNode;
	}
	public needsUpdate(): boolean
	{
		return this.m_needsUpdate;
	}
	public isResolved(): boolean
	{
		return this.m_universeFromNode != null;
	}
	
	public update( parents: PendingTransform[], parentFromNode: mat4, 
		updateCallback?: ( universeFromNode:mat4 ) => void,
		computeCallback?: TransformComputeFunction)
	{
		this.m_universeFromNode = undefined; // unresolve the transform if it's resolved
		this.m_needsUpdate = false;
		this.m_parents = parents;
		this.m_parentFromNode = parentFromNode ? parentFromNode : mat4.identity;
		this.m_applyFunction = updateCallback;
		this.m_computeFunction = computeCallback;

		this.checkForLoops();
	}

	private checkForLoops()
	{
		if( !this.m_parents )
			return;

		for( let test = this.m_parents[0]; test != null; test = test.m_parents ? test.m_parents[0] : null )
		{
			if( test == this )
			{
				throw "Somebody created a loop in transform parents";
			}
		}
	}
}


enum AnchorState
{
	Grabbed,
	Hooked,
	Parented,
}

interface NodeToNodeAnchor_t
{
	state: AnchorState;
	parentGlobalId: EndpointAddr;
	handleGlobalId?: EndpointAddr;
	parentFromGrabbable: mat4;
	grabbableParentFromGrabbableOrigin?: mat4;
	anchorToRestore?: NodeToNodeAnchor_t;
}

interface AvNodeRoot
{
	gadgetId: number;
	root: AvNode;
	hook?: string | EndpointAddr;
	hookFromGadget?: AvNodeTransform;
	handIsRelevant: Set<EHand>;
	wasGadgetDraggedLastFrame: boolean;
	remoteUniverse?: string;
}

interface RemoteUniverse
{
	uuid: string;
	remoteFromOrigin: { [originPath: string] : PendingTransform };
}

function handFromOriginPath( originPath: string )
{
	if ( originPath == "/user/hand/left" )
	{
		return EHand.Left;
	}
	else if ( originPath == "/user/hand/right" )
	{
		return EHand.Right;
	}
	else
	{
		return EHand.Invalid;
	}
}


export class AvDefaultTraverser implements InterfaceProcessorCallbacks
{
	private m_inFrameTraversal = false;
	private m_handDeviceForNode: { [nodeGlobalId:string]:EHand } = {};
	private m_currentHand = EHand.Invalid;
	private m_currentVisibility = true;
	private m_currentNodeByType: { [ nodeType: number] : AvNode[] } = {};
	private m_universeFromNodeTransforms: { [ nodeGlobalId:string ]: PendingTransform } = {};
	private m_nodeData: { [ nodeGlobalId:string ]: NodeData } = {};
	private m_lastFrameUniverseFromNodeTransforms: { [ nodeGlobalId:string ]: mat4 } = {};
	private m_roots: { [gadgetId:number] : AvNodeRoot } = {};
	private m_currentRoot: AvNodeRoot = null;
	private m_renderList: AvModelInstance[] = [];
	private m_nodeToNodeAnchors: { [ nodeGlobalId: string ]: NodeToNodeAnchor_t } = {};
	private m_hooksInUse: EndpointAddr[] = [];
	private m_endpoint: CRendererEndpoint = null;
	private m_frameNumber: number = 1;
	private m_actionState: { [ hand: number ] : AvActionState } = {};
	private m_dirtyGadgetActions = new Set<number>();
	private m_remoteUniverse: { [ universeUuid: string ]: RemoteUniverse } = {};
	private m_interfaceProcessor = new CInterfaceProcessor( this );
	private m_interfaceEntities: AvNode[] = [];
	private m_entityParentTransforms = new EndpointAddrMap<PendingTransform >();

	constructor()
	{
		this.m_endpoint = new CRendererEndpoint( this.onEndpointOpen );
		this.m_endpoint.registerHandler( MessageType.UpdateSceneGraph, this.onUpdateSceneGraph )
		this.m_endpoint.registerHandler( MessageType.NodeHaptic, this.onNodeHaptic );
		this.m_endpoint.registerHandler( MessageType.LostEndpoint, this.onLostEndpoint );
		this.m_endpoint.registerHandler( MessageType.InterfaceSendEvent, this.onInterfaceSendEvent );
		this.m_endpoint.registerHandler( MessageType.InterfaceLock, this.onInterfaceLock );
		this.m_endpoint.registerHandler( MessageType.InterfaceUnlock, this.onInterfaceUnlock );
		this.m_endpoint.registerHandler( MessageType.InterfaceRelock, this.onInterfaceRelock );
	}

	@bind onEndpointOpen(settings: AvRendererConfig)
	{
		Av().renderer.setRendererConfig(JSON.stringify(settings))
	}

	private forgetGadget( endpointId: number )
	{
			// TODO: Clean up drags and such?
			delete this.m_roots[ endpointId ];

	}

	@bind 
	onLostEndpoint( m: MsgLostEndpoint )
	{
		this.forgetGadget( m.endpointId );
	}

	@bind
	onInterfaceSendEvent( m: MsgInterfaceSendEvent, env: Envelope )
	{
		this.m_interfaceProcessor.interfaceEvent(m.destination, m.peer, m.iface, m.event );
		let response: MsgInterfaceSendEventResponse =
		{
		};
		this.m_endpoint.sendReply(MessageType.InterfaceSendEventResponse, response, env, 
			{ type: EndpointType.Renderer } );
	}

	@bind
	onInterfaceLock( m: MsgInterfaceLock, env: Envelope )
	{
		let result = this.m_interfaceProcessor.lockInterface(m.transmitter, m.receiver, m.iface );
		let response: MsgInterfaceLockResponse =
		{
			result,
		};
		this.m_endpoint.sendReply(MessageType.InterfaceLockResponse, response, env, 
			{ type: EndpointType.Renderer } );
	}
	
	@bind
	onInterfaceUnlock( m: MsgInterfaceUnlock, env: Envelope )
	{
		let result = this.m_interfaceProcessor.unlockInterface(m.transmitter, m.receiver, m.iface );
		let response: MsgInterfaceUnlockResponse =
		{
			result,
		};
		this.m_endpoint.sendReply(MessageType.InterfaceUnlockResponse, response, env, 
			{ type: EndpointType.Renderer } );
	}
	
	@bind
	onInterfaceRelock( m: MsgInterfaceRelock, env: Envelope )
	{
		let result = this.m_interfaceProcessor.relockInterface(m.transmitter, m.oldReceiver, m.newReceiver, m.iface );
		let response: MsgInterfaceRelockResponse =
		{
			result,
		};
		this.m_endpoint.sendReply(MessageType.InterfaceRelockResponse, response, env, 
			{ type: EndpointType.Renderer } );
	}
	
	interfaceStarted( transmitter: EndpointAddr, receiver: EndpointAddr, iface: string,
		transmitterFromReceiver: mat4, params?: object ):void
	{
		this.m_endpoint.sendMessage( MessageType.InterfaceStarted, 
			{
				transmitter,
				receiver,
				iface,
				transmitterFromReceiver: nodeTransformFromMat4( transmitterFromReceiver ),
				params,
			} as MsgInterfaceStarted );
	}

	interfaceEnded( transmitter: EndpointAddr, receiver: EndpointAddr, iface: string,
		transmitterFromReceiver: mat4 ):void
	{
		this.m_endpoint.sendMessage( MessageType.InterfaceEnded, 
			{
				transmitter,
				receiver,
				iface,
				transmitterFromReceiver: nodeTransformFromMat4( transmitterFromReceiver ),
			} as MsgInterfaceEnded );
	}

	interfaceTransformUpdated( destination: EndpointAddr, peer: EndpointAddr, iface: string, 
		destinationFromPeer: mat4 ): void
	{
		this.m_endpoint.sendMessage( MessageType.InterfaceTransformUpdated, 
			{
				destination,
				peer,
				iface,
				destinationFromPeer: nodeTransformFromMat4( destinationFromPeer ),
			} as MsgInterfaceTransformUpdated );
	}

	interfaceEvent( destination: EndpointAddr, peer: EndpointAddr, iface: string, event: object,
		destinationFromPeer: mat4 ): void
	{
		this.m_endpoint.sendMessage( MessageType.InterfaceReceiveEvent, 
			{
				destination,
				peer,
				iface,
				event,
				destinationFromPeer: nodeTransformFromMat4( destinationFromPeer ),
			} as MsgInterfaceReceiveEvent );
	}

	@bind 
	onUpdateSceneGraph( m: MsgUpdateSceneGraph, env: Envelope )
	{
		if( !m.root )
		{
			this.forgetGadget( env.sender.endpointId );
			return;
		}

		this.updateGlobalIds( m.root, env.sender.endpointId );
		let rootData = this.m_roots[ env.sender.endpointId ];
		if( !rootData )
		{
			rootData = this.m_roots[ env.sender.endpointId ] = 
			{ 
				gadgetId: env.sender.endpointId, 
				handIsRelevant: new Set<EHand>(),
				wasGadgetDraggedLastFrame: false,
				root: null 
			};
		}

		rootData.root = m.root;
		rootData.hook = m.hook;
		rootData.hookFromGadget = m.hookFromGadget;
		rootData.remoteUniverse = m.remoteUniversePath;
	}

	private updateGlobalIds( node: AvNode, gadgetId: number )
	{
		node.globalId =
		{
			type: EndpointType.Node,
			endpointId: gadgetId,
			nodeId: node.id,
		}

		if( node.children )
		{
			for( let child of node.children )
			{
				this.updateGlobalIds( child, gadgetId );
			}
		}
	}

	@bind
	public traverse()
	{
		if( !this.m_roots )
		{
			return;
		}

		this.m_inFrameTraversal = true;
		this.m_currentHand = EHand.Invalid;
		this.m_currentVisibility = true;
		this.m_currentNodeByType = {};
		this.m_universeFromNodeTransforms = {};
		this.m_renderList = [];
		this.m_interfaceEntities = [];
		this.m_entityParentTransforms = new EndpointAddrMap<PendingTransform >();

		this.clearHooksInUse();
		this.m_frameNumber++;

		for ( let gadgetId in this.m_roots )
		{
			this.traverseSceneGraph( this.m_roots[ gadgetId ] );
		}
	
		this.m_lastFrameUniverseFromNodeTransforms = {};
		for ( let nodeGlobalId in this.m_universeFromNodeTransforms )
		{
			let transform = this.m_universeFromNodeTransforms[ nodeGlobalId ];
			transform.resolve();
			this.m_lastFrameUniverseFromNodeTransforms[ nodeGlobalId] = transform.getUniverseFromNode();
		}
	
		this.m_inFrameTraversal = false;
	
		Av().renderer.renderList( this.m_renderList );

		this.updateInput();
		this.updateInterfaceProcessor();

		for( let gadgetId of this.m_dirtyGadgetActions )
		{
			this.sendUpdateActionState( gadgetId, EHand.Left );
			this.sendUpdateActionState( gadgetId, EHand.Right );
		}

		this.cleanupOldNodeData();
	}

	private updateInput()
	{
		this.updateActionState( EHand.Left );
		this.updateActionState( EHand.Right );
	}

	private sendUpdateActionState( gadgetId: number, hand: EHand )
	{
		if( this.m_inFrameTraversal )
		{
			throw new Error( "sendUpdateActionState not valid during traversal" );
		}

		let root = this.m_roots[ gadgetId ];
		if( !root )
		{
			return;
		}

		let actionState: AvActionState;
		if( /*root.wasGadgetDraggedLastFrame &&*/ root.handIsRelevant.has( hand ) )
		{
			actionState = filterActionsForGadget( this.m_actionState[ hand ] ); 
		}
		else
		{
			actionState = emptyActionState();
		}

		let m: MsgUpdateActionState =
		{
			gadgetId,
			hand,
			actionState,
		}

		this.m_endpoint.sendMessage( MessageType.UpdateActionState, m );
	}


	private updateActionState( hand: EHand )
	{
		let newActionState = Av().renderer.getActionState( hand );
		let oldActionState = this.m_actionState[ hand ]
		if( !equal( newActionState, oldActionState ) )
		{
			for( let gadgetId in this.m_roots )
			{
				let root = this.m_roots[ gadgetId ];
				if( !root.handIsRelevant.has( hand ) )
					continue;

				this.m_dirtyGadgetActions.add( root.gadgetId );
			}
			this.m_actionState[ hand ] = newActionState;
		}
	}

	private updateInterfaceProcessor()
	{
		let entities: InterfaceEntity[] = [];
		for( let entityNode of this.m_interfaceEntities )
		{
			let universeFromEntity = this.getTransform( entityNode.globalId );

			if( !universeFromEntity.isResolved() )
			{
				console.log( "Refusing to process interface entity because it has an unresolved transform",
					endpointAddrToString( entityNode.globalId ) );
				continue;
			}

			let entityData = this.getNodeData( entityNode );
			let volumes: TransformedVolume[] = [];
			if( !universeFromEntity.getOriginPath() || !entityData.lastVisible )
			{
				// if this entity doesn't have an origin path, forbid anything
				// from intersecting with it. It will still be able to participate in
				// existing locks or initial locks
				volumes.push(
					{
						type: EVolumeType.Empty,
						universeFromVolume: mat4.identity,
					} );
			}
			else
			{
				// compute the transform to universe for each volume
				for( let volume of entityNode.propVolumes ?? [] )
				{
					volumes.push( 
						{
							...volume,
							universeFromVolume: mat4.product( universeFromEntity.getUniverseFromNode(), 
								nodeTransformToMat4( volume.nodeFromVolume ?? {} ), new mat4() ),
						} );
				}
			}


			let initialLocks = entityNode.propInterfaceLocks ?? [];

			entities.push(
				{ 
					epa: entityNode.globalId,
					transmits: entityNode.propTransmits ?? [],
					receives: entityNode.propReceives ?? [],
					originPath: universeFromEntity.getOriginPath(),
					universeFromEntity: universeFromEntity.getUniverseFromNode(),
					wantsTransforms: 0 != ( entityNode.flags & ENodeFlags.NotifyOnTransformChange ),
					priority: entityNode.propPriority ?? 0,
					volumes,
					initialLocks,
				}
			);
		}

		this.m_interfaceProcessor.processFrame( entities );
	}

	getNodeData( node: AvNode ): NodeData
	{
		return this.getNodeDataByEpa( node.globalId, node.type );
	}

	getNodeDataByEpa( nodeGlobalId: EndpointAddr, typeHint?: AvNodeType ): NodeData
	{
		if( !nodeGlobalId )
		{
			return null;
		}

		if( typeHint === undefined )
		{
			typeHint = AvNodeType.Invalid;
		}

		let nodeIdStr = endpointAddrToString( nodeGlobalId );
		if( !this.m_nodeData.hasOwnProperty( nodeIdStr ) )
		{
			let nodeData = { lastFrameUsed: this.m_frameNumber, nodeType: typeHint };
			this.m_nodeData[ nodeIdStr] = nodeData;
			return nodeData;
		}
		else
		{
			let nodeData = this.m_nodeData[ nodeIdStr ];
			nodeData.lastFrameUsed = this.m_frameNumber;
			return nodeData;	
		}
	}

	cleanupOldNodeData()
	{
		let keys = Object.keys( this.m_nodeData );
		let frameToDeleteBefore = this.m_frameNumber - 2;
		for( let nodeIdStr of keys )
		{
			let nodeData = this.m_nodeData[ nodeIdStr ];
			if( nodeData.lastFrameUsed < frameToDeleteBefore )
			{
				delete this.m_nodeData[ nodeIdStr ];
			}
		}
	}

	
	traverseSceneGraph( root: AvNodeRoot ): void
	{
		if( root.root )
		{
			this.m_currentRoot = root;
			let oldRelevantHands = this.m_currentRoot.handIsRelevant;
			this.m_currentRoot.handIsRelevant = new Set<EHand>();
			this.m_currentRoot.wasGadgetDraggedLastFrame = false;

			// get the ID for node 0. We're going to use that as the parent of
			// everything. 
			let rootNode: AvNode;
			if( root.root.id == 0 )
			{
				rootNode = root.root;
			}
			else
			{
				rootNode = 
				{
					type: AvNodeType.Container,
					id: 0,
					flags: ENodeFlags.Visible,
					globalId: { type: EndpointType.Node, endpointId: root.root.globalId.endpointId, nodeId: 0 },
					children: [ root.root ],
				}
			}

			this.traverseNode( rootNode, null, null );

			// send empty action data for any hand that we don't care about anymore
			for( let hand of oldRelevantHands )
			{
				if( hand == EHand.Invalid )
					continue;

				if( !this.m_currentRoot.handIsRelevant.has( hand ) )
				{
					this.m_dirtyGadgetActions.add( root.gadgetId );
				}
			}

			// send the current action data for any hand that we don't care about anymore
			for( let hand of this.m_currentRoot.handIsRelevant )
			{
				if( hand == EHand.Invalid )
					continue;

				if( !oldRelevantHands.has( hand ) )
				{
					this.m_dirtyGadgetActions.add( root.gadgetId );
				}
			}
			
			this.m_currentRoot = null;
		}
	}

	private getRemoteUniverse( universeUuid?: string ): RemoteUniverse
	{
		if( !universeUuid )
			return null;

		let remoteUniverse = this.m_remoteUniverse[ universeUuid ];
		if( !remoteUniverse )
		{
			remoteUniverse = 
			{
				uuid: universeUuid,
				remoteFromOrigin: {},
			};
			
			this.m_remoteUniverse[ universeUuid ] = remoteUniverse;
		}
		return remoteUniverse;
	}

	private getRemoteOriginTransform( universeId: string, originPath: string ): PendingTransform
	{
		let universe = this.getRemoteUniverse( universeId );
		let originTransform = universe.remoteFromOrigin[ originPath ];
		if( !originTransform )
		{
			originTransform = new PendingTransform( universeId + "/" + originPath );
			universe.remoteFromOrigin[ originPath ] = originTransform;
		}
		return originTransform;
	}
	

	traverseNode( node: AvNode, defaultParent: PendingTransform, parentGlobalId?: EndpointAddr ): void
	{
		let handBefore = this.m_currentHand;
		let visibilityBefore = this.m_currentVisibility;

		let nodeData = this.getNodeData( node );
		nodeData.graphParent = parentGlobalId;

		this.m_currentVisibility = ( 0 != ( node.flags & ENodeFlags.Visible ) ) 
			&& this.m_currentVisibility;

		switch ( node.type )
		{
		case AvNodeType.Container:
			// nothing special to do here
			break;

		case AvNodeType.Origin:
			this.traverseOrigin( node, defaultParent );
			break;

		case AvNodeType.Transform:
			this.traverseTransform( node, defaultParent );
			break;

		case AvNodeType.Model:
			this.traverseModel( node, defaultParent );
			break;

		case AvNodeType.Panel:
			this.traversePanel( node, defaultParent );
			break;

		case AvNodeType.Line:
			this.traverseLine( node, defaultParent );
			break;
		
		case AvNodeType.ParentTransform:
			this.traverseParentTransform( node, defaultParent );
			break;
		
		case AvNodeType.HeadFacingTransform:
			this.traverseHeadFacingTransform( node, defaultParent );
			break;
		
		case AvNodeType.Child:
			this.traverseChild( node, defaultParent );
			break;

		case AvNodeType.InterfaceEntity:
			this.traverseInterfaceEntity( node, defaultParent );
			break;
			
		default:
			throw "Invalid node type";
		}

		if( !this.m_currentNodeByType[ node.type ] )
		{
			this.m_currentNodeByType[ node.type ] = [];
		}
		this.m_currentNodeByType[ node.type ].push( node );

		nodeData.lastFlags = node.flags;
		nodeData.lastNode = node;
		nodeData.lastVisible = this.m_currentVisibility;
		
		let thisNodeTransform = this.getTransform( node.globalId );
		if ( thisNodeTransform.needsUpdate() )
		{
			thisNodeTransform.update( defaultParent ? [ defaultParent ] : null, mat4.identity );
		}

		this.m_handDeviceForNode[ endpointAddrToString( node.globalId ) ] = this.m_currentHand;

		if( node.children )
		{
			for ( let child of node.children )
			{
				this.traverseNode( child, thisNodeTransform, node.globalId );
			}
		}

		this.m_currentNodeByType[ node.type ].pop();

		// remember that we used this hand
		this.m_currentRoot.handIsRelevant.add( this.m_currentHand );

		this.m_currentHand = handBefore;
		this.m_currentVisibility = visibilityBefore;
	}


	traverseOrigin( node: AvNode, defaultParent: PendingTransform )
	{
		this.setHookOrigin( node.propOrigin, node );
	}


	setHookOrigin( origin: string | EndpointAddr, node: AvNode, hookFromGrabbable?: AvNodeTransform )
	{
		if( typeof origin === "string" )
		{
			if( this.m_currentRoot.remoteUniverse )
			{
				let originTransform = this.getRemoteOriginTransform( this.m_currentRoot.remoteUniverse, 
					origin );
				let transform = this.updateTransform( node.globalId, originTransform, null, null );
				transform.setOriginPath( this.m_currentRoot.remoteUniverse + origin );
			}
			else
			{
				let parentFromOriginArray = Av().renderer.getUniverseFromOriginTransform( origin );
				if( parentFromOriginArray )
				{
					let transform = this.updateTransform( node.globalId, null, 
						new mat4( parentFromOriginArray ), null );
					transform.setOriginPath( origin );
				}
			}

			this.m_currentHand = handFromOriginPath( origin );
		}
		else if( origin != null )
		{
			let grabberFromGrabbable = mat4.identity;
			if( hookFromGrabbable )
			{
				grabberFromGrabbable = nodeTransformToMat4( hookFromGrabbable );
			}
			this.m_nodeToNodeAnchors[ endpointAddrToString( node.globalId ) ] =
			{
				state: AnchorState.Hooked,
				parentGlobalId: origin,
				parentFromGrabbable: grabberFromGrabbable,
			}
		}
	}

	traverseTransform( node: AvNode, defaultParent: PendingTransform )
	{
		if ( node.propTransform )
		{
			let mat = nodeTransformToMat4( node.propTransform );
			this.updateTransform( node.globalId, defaultParent, mat, null );
		}
	}

	traverseParentTransform( node: AvNode, defaultParent: PendingTransform )
	{
		if( node.propParentAddr )
		{
			let parentTransform = this.getTransform( node.propParentAddr );
			this.updateTransform( node.globalId, parentTransform, null, null );
		}
	}

	traverseHeadFacingTransform( node: AvNode, defaultParent: PendingTransform )
	{
		let universeFromHead = new mat4( Av().renderer.getUniverseFromOriginTransform( "/user/head" ) );
		this.updateTransformWithCompute( node.globalId, [ defaultParent ], null, null,
			( universeFromParents: mat4[], parentFromNode ) =>
			{
				let yAxisRough = new vec3( [ 0, 1, 0 ] );
				let hmdUp = universeFromHead.multiplyVec3( new vec3( [ 0, 1, 0 ] ) );
				if( vec3.dot( yAxisRough, hmdUp ) < 0.1 )
				{
					yAxisRough = hmdUp;
				}

				let universeFromNodeTranslation = universeFromParents[0].multiply( parentFromNode );
				let nodeTranslation = universeFromNodeTranslation.multiplyVec4( new vec4( [ 0, 0, 0, 1 ] ) );
				let headTranslation = universeFromHead.multiplyVec4( new vec4( [ 0, 0, 0, 1 ] ) );
				let zAxis = new vec3( headTranslation.subtract( nodeTranslation ).xyz ).normalize();
				let xAxis = vec3.cross( yAxisRough, zAxis, new vec3() ).normalize();
				let yAxis = vec3.cross( zAxis, xAxis );

				let universeFromNode = new mat4(
					[ 
						xAxis.x, xAxis.y, xAxis.z, 0,
						yAxis.x, yAxis.y, yAxis.z, 0,
						zAxis.x, zAxis.y, zAxis.z, 0,
						nodeTranslation.x, nodeTranslation.y, nodeTranslation.z, 1,
					]
				);				
				return universeFromNode;
			} );
	}

	traverseModel( node: AvNode, defaultParent: PendingTransform )
	{
		let nodeData = this.getNodeData( node );

		if ( nodeData.lastFailedModelUri != node.propModelUri )
		{
			nodeData.lastFailedModelUri = null;
		}

		let filteredUri: string;
		let endpointFieldUri = parseEndpointFieldUri( node.propModelUri );
		if( !endpointFieldUri )
		{
			filteredUri = node.propModelUri;
		}
		else
		{
			let [ epa, field ] = endpointFieldUri;
			let nodeData = this.getNodeDataByEpa( epa );
			if( nodeData && nodeData.lastNode )
			{
				let fieldValue = ( nodeData.lastNode as any )[ field ];
				if( typeof fieldValue == "string" )
				{
					filteredUri = fieldValue;
				}
			}
		}

		let modelToLoad = nodeData.lastFailedModelUri ? g_builtinModelError : filteredUri 
		if ( nodeData.lastModelUri != modelToLoad )
		{
			nodeData.modelInstance = null;
		}

		if ( !nodeData.modelInstance )
		{
			try
			{
				nodeData.modelInstance = Av().renderer.createModelInstance( modelToLoad );
				if ( nodeData.modelInstance )
				{
					nodeData.lastModelUri = filteredUri;
				}
			}
			catch( e )
			{
				nodeData.lastFailedModelUri = node.propModelUri;

				let m: MsgResourceLoadFailed =
				{
					nodeId: node.globalId,
					resourceUri: modelToLoad,
					error: e.message,
				};

				this.m_endpoint.sendMessage( MessageType.ResourceLoadFailed, m );
			}
		}

		if ( nodeData.modelInstance )
		{
			if( node.propColor )
			{
				let alpha = ( node.propColor.a == undefined ) ? 1 : node.propColor.a;
				nodeData.modelInstance.setBaseColor( 
					[ node.propColor.r, node.propColor.g, node.propColor.b, alpha ] );
			}
			try
			{
				if( node.propSharedTexture )
				{
					nodeData.modelInstance.setOverrideTexture( node.propSharedTexture );
				}
			}
			catch( e )
			{
				// just eat these and don't add the panel. Sometimes we find out about a panel 
				// before we find out about its texture
				return;
			}

			let internalScale = 1;
			if( node.propScaleToFit )
			{
				let aabb = Av().renderer.getAABBForModel( modelToLoad );
				if( !aabb )
				{
					// if we were told to scale the model, but it isn't loaded at this point,
					// abort drawing it so we don't have one frame of a wrongly-scaled model
					// as it loads in.
					return;
				}

				let possibleScale = minIgnoringNulls(
					scaleAxisToFit( node.propScaleToFit.x, aabb.xMin, aabb.xMax ),
					scaleAxisToFit( node.propScaleToFit.y, aabb.yMin, aabb.yMax ),
					scaleAxisToFit( node.propScaleToFit.z, aabb.zMin, aabb.zMax ) );
				if( possibleScale != null )
				{
					internalScale = possibleScale;
				}
			}

			let showModel = this.m_currentVisibility;
			this.updateTransform( node.globalId, defaultParent, mat4.identity,
				( universeFromNode: mat4 ) =>
			{
				if( internalScale != 1 )
				{
					let scaledNodeFromModel = scaleMat( new vec3( [ internalScale, internalScale, internalScale ] ) );
					universeFromNode = new mat4( universeFromNode.all() ).multiply( scaledNodeFromModel );
				}
				nodeData.modelInstance.setUniverseFromModelTransform( universeFromNode.all() );
				if( showModel )
				{
					this.m_renderList.push( nodeData.modelInstance );
				}
			} );
		}
	}

	traversePanel( node: AvNode, defaultParent: PendingTransform )
	{
		let nodeData = this.getNodeData( node );

		// if we don't have shared texture info for this panel yet, there's
		// nothing to do here
		if( !node.propSharedTexture )
			return;

		let textureInfo = node.propSharedTexture;

		if ( !nodeData.modelInstance )
		{
			let sPanelModelUri = g_builtinModelPanel;
			if( textureInfo.invertY )
			{
				sPanelModelUri = g_builtinModelPanelInverted;
			}

			nodeData.modelInstance = Av().renderer.createModelInstance( sPanelModelUri );
		}

		if ( nodeData.modelInstance )
		{
			try
			{
				nodeData.modelInstance.setOverrideTexture( textureInfo );
			}
			catch( e )
			{
				// just eat these and don't add the panel. Sometimes we find out about a panel 
				// before we find out about its texture
				return;
			}

			let hand = this.m_currentHand;
			let showModel = this.m_currentVisibility;
			this.updateTransform( node.globalId, defaultParent, mat4.identity,
				( universeFromNode: mat4 ) =>
			{
				nodeData.modelInstance.setUniverseFromModelTransform( universeFromNode.all() );
				if( showModel )
				{
					this.m_renderList.push( nodeData.modelInstance );
				}
			} );
		}
	}

	getCurrentNodeOfType( type: AvNodeType ): AvNode
	{
		return this.m_currentNodeByType[ type ]?.[ this.m_currentNodeByType[ type ].length - 1 ];
	}

	traverseLine( node: AvNode, defaultParent: PendingTransform )
	{
		if( !node.propEndAddr )
		{
			return;
		}

		let lineEndTransform = this.getTransform( node.propEndAddr );
		let thickness = node.propThickness === undefined ? 0.003 : node.propThickness;
		this.updateTransformWithCompute( node.globalId,
			[ defaultParent, lineEndTransform ],
			mat4.identity, null,
			( [ universeFromStart, universeFromEnd ]: mat4[], unused: mat4) =>
			{
				let nodeData = this.getNodeData( node );

				if ( !nodeData.modelInstance )
				{
					nodeData.modelInstance = Av().renderer.createModelInstance( g_builtinModelCylinder );
					if ( nodeData.modelInstance )
					{
						nodeData.lastModelUri = g_builtinModelCylinder;
					}
				}
		
				if ( nodeData.modelInstance )
				{
					if( node.propColor )
					{
						let alpha = ( node.propColor.a == undefined ) ? 1 : node.propColor.a;
						nodeData.modelInstance.setBaseColor( 
							[ node.propColor.r, node.propColor.g, node.propColor.b, alpha ] );
					}
		
					let startPos = new vec3( universeFromStart.multiplyVec4( new vec4( [ 0, 0, 0, 1 ] ) ).xyz );
					let endPos = new vec3( universeFromEnd.multiplyVec4( new vec4( [ 0, 0, 0, 1 ] ) ).xyz );
					let lineVector = new vec3( endPos.xyz );
					lineVector.subtract( startPos );
					let lineLength = lineVector.length();
					lineVector.normalize();

					let startGap = node.propStartGap ? node.propStartGap : 0;
					let endGap = node.propEndGap ? node.propEndGap : 0;
					if( startGap + endGap < lineLength )
					{
						let actualStart = vec3MultiplyAndAdd( startPos, lineVector, startGap );
						let actualEnd = vec3MultiplyAndAdd( endPos, lineVector, -endGap );
						let universeFromLine = 	computeUniverseFromLine( actualStart, actualEnd, thickness ); 

						nodeData.modelInstance.setUniverseFromModelTransform( universeFromLine.all() );
						this.m_renderList.push( nodeData.modelInstance );
					}

				}
		
				return new mat4();
			} );
	}

	traverseChild( node: AvNode, defaultParent: PendingTransform )
	{
		if( node.propChildAddr )
		{
			// TODO: Remember the ID of the parent entity and ignore child nodes that
			// don't match the parent specified on the child entity itself
			if( this.m_entityParentTransforms.has( node.propChildAddr ) )
			{
				let oldTransform = this.m_entityParentTransforms.get( node.propChildAddr );
				oldTransform.update( [ defaultParent ], mat4.identity );
			}
			else
			{
				this.m_entityParentTransforms.set( node.propChildAddr, defaultParent );
			}
		}
	}
	
	traverseInterfaceEntity( node: AvNode, defaultParent: PendingTransform )
	{
		for( let volume of node.propVolumes ?? [] )
		{
			if( volume.type == EVolumeType.ModelBox && !volume.aabb)
			{
				try
				{
					volume.aabb = Av().renderer.getAABBForModel( volume.uri );
				}
				catch( e )
				{
					let nodeData = this.getNodeData( node );
					if( nodeData.lastFailedModelUri != volume.uri )
					{
						let m: MsgResourceLoadFailed =
						{
							nodeId: node.globalId,
							resourceUri: volume.uri,
							error: e.message,
						};
		
						this.m_endpoint.sendMessage( MessageType.ResourceLoadFailed, m );
					}
				}
			}
		}


		this.m_interfaceEntities.push( node );

		if( node.propParentAddr )
		{
			// TODO: Only look for parent transforms that match this node's propParent addr
			if( !this.m_entityParentTransforms.has( node.globalId ) )
			{
				let newParent = new PendingTransform( endpointAddrToString( node.globalId ) + "_parent" );
				this.m_entityParentTransforms.set( node.globalId, newParent );
			}

			this.updateTransform( node.globalId, this.m_entityParentTransforms.get( node.globalId ), 
				null, null );
		}
	}

	
	getTransform( globalNodeId: EndpointAddr ): PendingTransform
	{
		let idStr = endpointAddrToString( globalNodeId );
		if( idStr == "0" )
			return null;

		if( !this.m_universeFromNodeTransforms.hasOwnProperty( idStr ) )
		{
			this.m_universeFromNodeTransforms[ idStr ] = new PendingTransform( idStr );
		}
		return this.m_universeFromNodeTransforms[ idStr ];
	}

	// This is only useful in certain special circumstances where the fact that a 
	// transform will be needed is known before the endpoint ID of the node that 
	// will provide the transform is known. You probably want updateTransform(...)
	setTransform( globalNodeId: EndpointAddr, newTransform: PendingTransform )
	{
		let idStr = endpointAddrToString( globalNodeId );
		if( idStr != "0" )
		if( !this.m_universeFromNodeTransforms.hasOwnProperty( idStr ) )
		{
			this.m_universeFromNodeTransforms[ idStr ] = newTransform;
		}
	}

	updateTransform( globalNodeId: EndpointAddr,
		parent: PendingTransform, parentFromNode: mat4,
		applyFunction: ( universeFromNode: mat4 ) => void )
	{
		let transform = this.getTransform( globalNodeId );
		transform.update( parent ? [ parent ] : null, parentFromNode, applyFunction );
		return transform;
	}

	updateTransformWithCompute( globalNodeId: EndpointAddr,
		parents: PendingTransform[], parentFromNode: mat4,
		applyFunction: ( universeFromNode: mat4 ) => void,
		computeFunction: TransformComputeFunction )
	{
		let transform = this.getTransform( globalNodeId );
		transform.update( parents, parentFromNode, applyFunction, computeFunction );
		return transform;
	}

	
	@bind
	public onNodeHaptic( m: MsgNodeHaptic  )
	{
		let transform = this.getTransform( m.nodeId );
		let hand = handFromOriginPath( transform?.getOriginPath() );
		if( hand != EHand.Invalid )
		{
			Av().renderer.sendHapticEventForHand( hand, m.amplitude, m.frequency, m.duration );
		}
	}

	private isHookInUse( nodeId: EndpointAddr )
	{
		let hookData = this.getNodeDataByEpa( nodeId );
		if( hookData && hookData.lastFlags & ENodeFlags.AllowMultipleDrops )
		{
			return false;
		}

		for( let hookId of this.m_hooksInUse )
		{
			if( endpointAddrsMatch( nodeId, hookId ) )
				return true;
		}
		return false;
	}

	private addHookInUse( nodeId: EndpointAddr )
	{
		this.m_hooksInUse.push( nodeId );
	}

	private clearHooksInUse()
	{
		this.m_hooksInUse = [];
	}

	@bind
	private getLastUniverseFromNode( nodeAddr: EndpointAddr ): mat4
	{
		let nodeGlobalId = endpointAddrToString( nodeAddr );
		if( !this.m_lastFrameUniverseFromNodeTransforms.hasOwnProperty( nodeGlobalId ) )
		{
			return mat4.identity;
		}
		else
		{
			return this.m_lastFrameUniverseFromNodeTransforms[ nodeGlobalId ];
		}
	}

}


